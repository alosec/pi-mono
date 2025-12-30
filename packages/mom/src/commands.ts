/**
 * Command handling for mom
 *
 * Parses and routes slash commands.
 * Commands start with "/" and are handled before passing to the agent.
 */

import { handleAuthStatus, handleLogin, handleLogout, tryCompleteLogin } from "./auth.js";
import type { SlackBot } from "./slack.js";

export interface CommandContext {
	channelId: string;
	text: string;
	slack: SlackBot;
}

export interface CommandResult {
	handled: boolean;
}

/**
 * Try to handle a message as a command.
 * Returns { handled: true } if the message was a command and was processed.
 * Returns { handled: false } if the message should be passed to the agent.
 */
export async function tryHandleCommand(ctx: CommandContext): Promise<CommandResult> {
	const text = ctx.text.trim();

	// Auth commands
	if (text === "/login" || text === "/login anthropic") {
		handleLogin(ctx.channelId, ctx.slack);
		return { handled: true };
	}
	if (text === "/logout" || text === "/logout anthropic") {
		await handleLogout(ctx.channelId, ctx.slack);
		return { handled: true };
	}
	if (text === "/auth-status" || text === "/auth") {
		await handleAuthStatus(ctx.channelId, ctx.slack);
		return { handled: true };
	}

	// Check for pending auth code completion (not a command, but intercepts message)
	if (tryCompleteLogin(ctx.channelId, text)) {
		return { handled: true };
	}

	// Future commands go here:
	// /model, /config, /help, etc.

	return { handled: false };
}
