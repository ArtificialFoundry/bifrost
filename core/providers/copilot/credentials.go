package copilot

import "strings"

// GitHub token prefixes. See
// https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
const (
	tokenPrefixOAuthUserToken     = "gho_"        // GitHub OAuth App user-to-server token — this provider's device-code flow
	tokenPrefixGithubAppUserToken = "ghu_"        // GitHub App user-to-server token
	tokenPrefixFineGrainedPAT     = "github_pat_" // Fine-grained personal access token
)

// credentialKind identifies what a raw GitHub token string is, so credential resolution
// can pick the right auth path without a hand-set config flag.
type credentialKind int

const (
	// credentialKindUnknown means the token has no recognizable GitHub prefix (or is
	// empty). This is not necessarily an error: a pre-minted Copilot API token (upstream's
	// GithubCopilotKeyConfig static-token path) carries no GitHub prefix at all, so callers
	// must fall back to an explicit field rather than reject the value outright.
	credentialKindUnknown credentialKind = iota
	// credentialKindOAuthUserToken is a gho_-prefixed OAuth App user token — this
	// provider's device-code flow (client_id Iv1.b507a08c87ecfe98, scope read:user)
	// produces exactly this shape, and it is what prod's live config_providers id=5
	// ("agent47nh") key holds today.
	credentialKindOAuthUserToken
	// credentialKindGithubAppUserToken is a ghu_-prefixed GitHub App user-to-server token.
	// Distinct from credentialKindOAuthUserToken: it is minted by a GitHub App acting on
	// behalf of a user, not by this provider's OAuth device-code flow, but it is exchanged
	// through the same /copilot_internal/v2/token endpoint and is handled identically here.
	credentialKindGithubAppUserToken
	// credentialKindFineGrainedPAT is a github_pat_-prefixed fine-grained personal access
	// token.
	credentialKindFineGrainedPAT
)

// detectCredentialKind classifies a raw token string by its GitHub prefix.
//
// Prefix detection is preferred over a hand-set UI auth_mode flag because the prefix is
// reliable and already present on the stored value for every shape this provider accepts
// — an operator (or a migrated prod row) never has to declare what kind of token they
// pasted. Detection returns credentialKindUnknown when the prefix does not disambiguate
// (empty string, or a token with no recognizable GitHub prefix, e.g. a pre-minted Copilot
// API token minted directly for upstream's static-token path); callers must fall back to
// an explicit field in that case rather than guess.
func detectCredentialKind(token string) credentialKind {
	switch {
	case strings.HasPrefix(token, tokenPrefixOAuthUserToken):
		return credentialKindOAuthUserToken
	case strings.HasPrefix(token, tokenPrefixGithubAppUserToken):
		return credentialKindGithubAppUserToken
	case strings.HasPrefix(token, tokenPrefixFineGrainedPAT):
		return credentialKindFineGrainedPAT
	default:
		return credentialKindUnknown
	}
}

// isOAuthExchangeCredential reports whether a detected credential kind is one this
// provider's OAuth device-flow exchange path (GET /copilot_internal/v2/token with
// Authorization: Bearer <token>) knows how to handle. gho_, ghu_, and github_pat_ tokens
// are all exchanged identically by that endpoint; only credentialKindUnknown needs a
// different resolution path (explicit typed config or upstream's static pre-minted
// token).
func isOAuthExchangeCredential(kind credentialKind) bool {
	switch kind {
	case credentialKindOAuthUserToken, credentialKindGithubAppUserToken, credentialKindFineGrainedPAT:
		return true
	default:
		return false
	}
}
