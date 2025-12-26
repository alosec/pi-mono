/**
 * OAuth flow for mom - allows users to authenticate via Slack/email chat
 *
 * Flow:
 * 1. User sends "/login anthropic"
 * 2. Mom generates auth URL with PKCE, sends it to user
 * 3. User opens URL, authorizes, gets code
 * 4. User pastes code back to mom
 * 5. Mom exchanges code for tokens, saves to oauth.json
 */

import { createHash, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Anthropic OAuth config (same as pi-coding-agent)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

export interface OAuthCredentials {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
}

interface PendingAuth {
	verifier: string;
	challenge: string;
	createdAt: number;
}

// Pending auth sessions per channel
const pendingAuths = new Map<string, PendingAuth>();

// Timeout for pending auth (10 minutes)
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Get the path to mom's oauth.json
 */
export function getOAuthPath(workingDir: string): string {
	const momDir = join(workingDir, ".mom");
	if (!existsSync(momDir)) {
		mkdirSync(momDir, { recursive: true, mode: 0o700 });
	}
	return join(momDir, "oauth.json");
}

/**
 * Load OAuth credentials from mom's storage
 */
export function loadCredentials(workingDir: string): OAuthCredentials | null {
	const filePath = getOAuthPath(workingDir);
	if (!existsSync(filePath)) {
		return null;
	}

	try {
		const content = readFileSync(filePath, "utf-8");
		const data = JSON.parse(content);
		return data.anthropic || null;
	} catch (error) {
		console.error(`Failed to load OAuth credentials: ${error}`);
		return null;
	}
}

/**
 * Save OAuth credentials to mom's storage
 */
export function saveCredentials(workingDir: string, credentials: OAuthCredentials): void {
	const filePath = getOAuthPath(workingDir);
	const data = { anthropic: credentials };
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
	chmodSync(filePath, 0o600);
}

/**
 * Remove OAuth credentials
 */
export function removeCredentials(workingDir: string): void {
	const filePath = getOAuthPath(workingDir);
	if (existsSync(filePath)) {
		writeFileSync(filePath, "{}", "utf-8");
	}
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/**
 * Start the OAuth login flow
 * Returns the authorization URL for the user to visit
 */
export function startLogin(channelId: string): string {
	// Clean up expired pending auths
	const now = Date.now();
	for (const [id, pending] of pendingAuths) {
		if (now - pending.createdAt > AUTH_TIMEOUT_MS) {
			pendingAuths.delete(id);
		}
	}

	const { verifier, challenge } = generatePKCE();

	// Store pending auth
	pendingAuths.set(channelId, {
		verifier,
		challenge,
		createdAt: now,
	});

	// Build authorization URL
	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	return `${AUTHORIZE_URL}?${authParams.toString()}`;
}

/**
 * Check if a channel has a pending auth
 */
export function hasPendingAuth(channelId: string): boolean {
	const pending = pendingAuths.get(channelId);
	if (!pending) return false;

	// Check if expired
	if (Date.now() - pending.createdAt > AUTH_TIMEOUT_MS) {
		pendingAuths.delete(channelId);
		return false;
	}

	return true;
}

/**
 * Complete the OAuth flow with the authorization code
 */
export async function completeLogin(
	channelId: string,
	authCode: string,
	workingDir: string,
): Promise<{ success: boolean; error?: string }> {
	const pending = pendingAuths.get(channelId);
	if (!pending) {
		return { success: false, error: "No pending login. Use /login to start." };
	}

	// Check if expired
	if (Date.now() - pending.createdAt > AUTH_TIMEOUT_MS) {
		pendingAuths.delete(channelId);
		return { success: false, error: "Login expired. Use /login to start again." };
	}

	// Parse the code - format is "code#state"
	const splits = authCode.trim().split("#");
	const code = splits[0];
	const state = splits[1];

	try {
		// Exchange code for tokens
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code: code,
				state: state,
				redirect_uri: REDIRECT_URI,
				code_verifier: pending.verifier,
			}),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			pendingAuths.delete(channelId);
			return { success: false, error: `Token exchange failed: ${error}` };
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		// Calculate expiry time (current time + expires_in seconds - 5 min buffer)
		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		// Save credentials
		const credentials: OAuthCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
		};

		saveCredentials(workingDir, credentials);
		pendingAuths.delete(channelId);

		return { success: true };
	} catch (error) {
		pendingAuths.delete(channelId);
		return { success: false, error: `Login failed: ${error}` };
	}
}

/**
 * Cancel a pending login
 */
export function cancelLogin(channelId: string): void {
	pendingAuths.delete(channelId);
}

/**
 * Refresh the OAuth token using the refresh token
 */
export async function refreshToken(workingDir: string): Promise<string | null> {
	const credentials = loadCredentials(workingDir);
	if (!credentials) {
		return null;
	}

	try {
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: credentials.refresh,
			}),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			console.error(`Token refresh failed: ${error}`);
			return null;
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		// Calculate expiry time
		const expiresAt = Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000;

		// Save new credentials
		const newCredentials: OAuthCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: expiresAt,
		};

		saveCredentials(workingDir, newCredentials);

		return newCredentials.access;
	} catch (error) {
		console.error(`Token refresh error: ${error}`);
		return null;
	}
}

/**
 * Get a valid OAuth token, refreshing if necessary
 */
export async function getOAuthToken(workingDir: string): Promise<string | null> {
	const credentials = loadCredentials(workingDir);
	if (!credentials) {
		return null;
	}

	// Check if token is expired (with 5 min buffer already applied)
	if (Date.now() >= credentials.expires) {
		// Token expired - refresh it
		return await refreshToken(workingDir);
	}

	return credentials.access;
}

/**
 * Check if user is logged in
 */
export function isLoggedIn(workingDir: string): boolean {
	return loadCredentials(workingDir) !== null;
}
