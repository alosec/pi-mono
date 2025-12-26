#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { syncLogToContext } from "./context.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import * as oauth from "./oauth.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type MomHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!MOM_SLACK_BOT_TOKEN) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, MOM_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--sandbox=host|docker:<name>] <working-directory>");
	console.error("       mom --download <channel-id>");
	process.exit(1);
}

const { workingDir, sandbox } = { workingDir: parsedArgs.workingDir, sandbox: parsedArgs.sandbox };

// Check for Slack tokens (always required)
if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

// Check for Anthropic auth - can be env vars OR OAuth
const hasOAuthCredentials = oauth.isLoggedIn(workingDir);
const hasEnvCredentials = !!(ANTHROPIC_API_KEY || ANTHROPIC_OAUTH_TOKEN);

if (!hasOAuthCredentials && !hasEnvCredentials) {
	console.log("No Anthropic credentials found. Users can authenticate with /login command.");
	console.log("Alternatively, set ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN environment variable.");
}

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		isInThread: !!event.thread_ts,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? accumulatedText + "\n" + text : text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (event.thread_ts) {
					// Respond in the same thread as the triggering message
					messageTs = await slack.postInThread(event.channel, event.thread_ts, displayText);
				} else {
					messageTs = await slack.postMessage(event.channel, displayText);
				}

				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, displayText);
				} else if (event.thread_ts) {
					messageTs = await slack.postInThread(event.channel, event.thread_ts, displayText);
				} else {
					messageTs = await slack.postMessage(event.channel, displayText);
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				if (messageTs) {
					const ts = await slack.postInThread(event.channel, messageTs, text);
					threadMessageTs.push(ts);
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
						if (event.thread_ts) {
							messageTs = await slack.postInThread(
								event.channel,
								event.thread_ts,
								accumulatedText + workingIndicator,
							);
						} else {
							messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
						}
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title, event.thread_ts);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (messageTs) {
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					await slack.updateMessage(event.channel, messageTs, displayText);
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // Save for updating later
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);
		const channelDir = join(workingDir, event.channel);
		const text = event.text.trim();

		// ========================================================================
		// OAuth commands - handle before agent
		// ========================================================================

		// /login - start OAuth flow
		if (text === "/login" || text === "/login anthropic") {
			const authUrl = oauth.startLogin(event.channel);
			await slack.postMessage(
				event.channel,
				`*Login to Anthropic*\n\n` +
					`1. Open this URL:\n${authUrl}\n\n` +
					`2. Sign in and authorize\n\n` +
					`3. Copy the code and paste it here\n\n` +
					`_The code looks like: abc123...#xyz789..._`,
			);
			return;
		}

		// /logout - clear credentials
		if (text === "/logout" || text === "/logout anthropic") {
			oauth.removeCredentials(workingDir);
			await slack.postMessage(event.channel, "✓ Logged out of Anthropic");
			return;
		}

		// /auth-status - check login status
		if (text === "/auth-status" || text === "/auth") {
			const loggedIn = oauth.isLoggedIn(workingDir);
			const hasEnvKey = !!(process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
			const status = loggedIn
				? "✓ Logged in via OAuth"
				: hasEnvKey
					? "Using API key from environment"
					: "✗ Not authenticated. Use /login to authenticate.";
			await slack.postMessage(event.channel, status);
			return;
		}

		// Check for pending auth code (looks like "code#state")
		if (oauth.hasPendingAuth(event.channel) && text.includes("#") && !text.startsWith("/")) {
			const result = await oauth.completeLogin(event.channel, text, workingDir);
			if (result.success) {
				await slack.postMessage(
					event.channel,
					"✓ Successfully logged in to Anthropic!\n\nYou can now use Claude without an API key.",
				);
			} else {
				await slack.postMessage(event.channel, `✗ Login failed: ${result.error}`);
			}
			return;
		}

		// ========================================================================
		// Normal message handling
		// ========================================================================

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// SYNC context from log.jsonl BEFORE processing
			// This adds any messages that were logged while mom wasn't running
			// Exclude messages >= current ts (will be handled by agent)
			const syncedCount = syncLogToContext(channelDir, event.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${event.channel}] Synced ${syncedCount} messages from log to context`);
			}

			// Create context adapter
			const ctx = createSlackContext(event, slack, state, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			// Signal completion to protocol adapter if present
			const adapterUrl = process.env.MOM_SLACK_API_URL;
			if (adapterUrl) {
				// adapterUrl is like http://localhost:3000/api/ - get base URL
				const baseUrl = adapterUrl.replace(/\/api\/?$/, "");
				fetch(`${baseUrl}/done`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ channel: event.channel }),
				}).catch(() => {});
			}

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Shared store for attachment downloads (also used per-channel in getState)
const sharedStore = new ChannelStore({ workingDir, botToken: MOM_SLACK_BOT_TOKEN! });

const bot = new SlackBotClass(handler, {
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
	workingDir,
	store: sharedStore,
});

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

bot.start();
