/**
 * OAuth authentication for mom
 *
 * Handles /login, /logout, /auth-status commands and manages credentials.
 * Uses AuthStorage from pi-coding-agent for the actual OAuth flow.
 */

import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import * as log from "./log.js";

// ============================================================================
// Auth Storage (singleton)
// ============================================================================

const AUTH_PATH = join(homedir(), ".pi", "mom", "auth.json");
const authStorage = new AuthStorage(AUTH_PATH);

/**
 * Get the shared AuthStorage instance.
 * Used by agent.ts to get API keys.
 */
export function getAuthStorage(): AuthStorage {
	return authStorage;
}

// ============================================================================
// Pending Login State
// ============================================================================

interface PendingLogin {
	resolve: (code: string) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

const pendingLogins = new Map<string, PendingLogin>();
const AUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Command Handlers
// ============================================================================

export interface SlackPoster {
	postMessage(channelId: string, text: string): Promise<string>;
}

/**
 * Handle /login command - start OAuth flow
 */
export async function handleLogin(channelId: string, slack: SlackPoster): Promise<void> {
	// Cancel any existing pending login for this channel
	const existing = pendingLogins.get(channelId);
	if (existing) {
		clearTimeout(existing.timeout);
		existing.reject(new Error("Login cancelled - new login started"));
		pendingLogins.delete(channelId);
	}

	log.logInfo(`[${channelId}] Starting OAuth login`);

	try {
		await authStorage.login("anthropic", {
			onAuth: ({ url }) => {
				slack.postMessage(
					channelId,
					`*Login to Anthropic*\n\n` +
						`1. Open this URL:\n${url}\n\n` +
						`2. Sign in and authorize\n\n` +
						`3. Copy the code and paste it here\n\n` +
						`_The code looks like: abc123...#xyz789..._`,
				);
			},
			onPrompt: () => {
				return new Promise<string>((resolve, reject) => {
					const timeout = setTimeout(() => {
						pendingLogins.delete(channelId);
						reject(new Error("Login timed out after 10 minutes"));
					}, AUTH_TIMEOUT_MS);

					pendingLogins.set(channelId, { resolve, reject, timeout });
				});
			},
		});

		log.logInfo(`[${channelId}] OAuth login successful`);
		await slack.postMessage(
			channelId,
			"✓ Successfully logged in to Anthropic!\n\nYou can now use Claude without an API key.",
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!message.includes("cancelled")) {
			log.logWarning(`[${channelId}] OAuth login failed`, message);
			await slack.postMessage(channelId, `✗ Login failed: ${message}`);
		}
	}
}

/**
 * Handle /logout command
 */
export async function handleLogout(channelId: string, slack: SlackPoster): Promise<void> {
	authStorage.logout("anthropic");
	log.logInfo(`[${channelId}] Logged out of Anthropic`);
	await slack.postMessage(channelId, "✓ Logged out of Anthropic");
}

/**
 * Handle /auth-status command
 */
export async function handleAuthStatus(channelId: string, slack: SlackPoster): Promise<void> {
	const hasOAuth = authStorage.has("anthropic");
	const hasEnvKey = !!(process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);

	const status = hasOAuth
		? "✓ Logged in via OAuth"
		: hasEnvKey
			? "Using API key from environment"
			: "✗ Not authenticated. Use /login to authenticate.";

	await slack.postMessage(channelId, status);
}

/**
 * Check if a message completes a pending login.
 * Returns true if the message was an auth code and login was completed.
 */
export function tryCompleteLogin(channelId: string, text: string): boolean {
	const pending = pendingLogins.get(channelId);
	if (!pending) return false;

	// Auth codes look like: code#state (both are base64url strings)
	if (text.includes("#") && !text.startsWith("/")) {
		clearTimeout(pending.timeout);
		pendingLogins.delete(channelId);
		pending.resolve(text.trim());
		return true;
	}

	return false;
}

/**
 * Check if there's a pending login for a channel.
 */
export function hasPendingLogin(channelId: string): boolean {
	return pendingLogins.has(channelId);
}
