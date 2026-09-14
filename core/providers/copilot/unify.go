// Package copilot implements the GitHub Copilot OAuth device-code-flow token exchange.
//
// This file exposes the OAuth exchange path (copilotTokenManager, token-prefix detection,
// negative-cache/backoff — WBS 2.1-2.3) to core/providers/githubcopilot, the unified
// provider package (WBS 2.4/2.5), without requiring githubcopilot to duplicate the
// exchange machinery. core/providers/copilot itself is retained, unchanged in its own
// request path, until subagent-4 confirms the unified provider is equivalent (5.1/5.2);
// only then does WBS 2.4 delete this package outright.
package copilot

import (
	"sync"

	schemas "github.com/maximhq/bifrost/core/schemas"
	"github.com/valyala/fasthttp"
)

// oauthTokenManagers is a package-level cache keyed by Key.ID, mirroring
// CopilotProvider.tokenManagers but shared across callers that don't hold a
// CopilotProvider instance (i.e. the unified githubcopilot provider). Kept separate from
// CopilotProvider.tokenManagers so the two providers' caches cannot cross-invalidate each
// other during the transition period where both packages exist side by side.
var oauthTokenManagers sync.Map // map[string]*CopilotTokenManagerEntry keyed by Key.ID

// ResolveOAuthCredentials exchanges a key's GitHub OAuth device-flow access token
// (GithubCopilotOAuthKeyConfig.AccessToken, falling back to the legacy Key.Value — see
// resolveOAuthAccessToken and INC-049) for a short-lived Copilot JWT and its API base URL.
//
// This is the single entry point the unified core/providers/githubcopilot provider uses
// for the OAuth auth mode (WBS 2.4/2.5), reusing this package's token manager — including
// its singleflight coalescing and negative-cache/backoff (WBS 2.3) — rather than
// duplicating the exchange logic in the unified package.
func ResolveOAuthCredentials(
	key schemas.Key,
	client *fasthttp.Client,
	logger schemas.Logger,
) (token string, apiBase string, bifrostErr *schemas.BifrostError) {
	currentToken := resolveOAuthAccessToken(key)

	if val, ok := oauthTokenManagers.Load(key.ID); ok {
		entry := val.(*CopilotTokenManagerEntry)
		if entry.accessToken == currentToken {
			return entry.tm.getToken()
		}
		tm := newCopilotTokenManager(currentToken, client, logger)
		newEntry := &CopilotTokenManagerEntry{tm: tm, accessToken: currentToken}
		if oauthTokenManagers.CompareAndSwap(key.ID, val, newEntry) {
			return tm.getToken()
		}
		winner, _ := oauthTokenManagers.Load(key.ID)
		return winner.(*CopilotTokenManagerEntry).tm.getToken()
	}

	tm := newCopilotTokenManager(currentToken, client, logger)
	entry := &CopilotTokenManagerEntry{tm: tm, accessToken: currentToken}
	actual, _ := oauthTokenManagers.LoadOrStore(key.ID, entry)
	return actual.(*CopilotTokenManagerEntry).tm.getToken()
}

// HasOAuthCredential reports whether a key carries an OAuth-device-flow credential this
// package's exchange path can use — the typed GithubCopilotOAuthKeyConfig, or a legacy
// Key.Value whose prefix (gho_/ghu_/github_pat_) this package's detection recognizes as
// one it knows how to exchange. Used by the unified provider to choose between this
// exchange path and upstream's GithubCopilotKeyConfig / pre-minted-token paths, without
// guessing on an unrecognized value. See INC-049.
func HasOAuthCredential(key schemas.Key) bool {
	if key.GithubCopilotOAuthKeyConfig != nil {
		return true
	}
	return isOAuthExchangeCredential(detectCredentialKind(key.Value.GetValue()))
}
