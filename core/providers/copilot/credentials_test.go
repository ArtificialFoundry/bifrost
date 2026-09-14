package copilot

import "testing"

func TestDetectCredentialKind(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  credentialKind
	}{
		{"gho_ OAuth App user token", "gho_16C7e42F292c6912E7710c838347Ae178B4a", credentialKindOAuthUserToken},
		{"ghu_ GitHub App user-to-server token", "ghu_16C7e42F292c6912E7710c838347Ae178B4a", credentialKindGithubAppUserToken},
		{"github_pat_ fine-grained PAT", "github_pat_11ABCDEFG0abcdefghijklmnop", credentialKindFineGrainedPAT},
		{"ambiguous/unknown — pre-minted Copilot API token, no GitHub prefix", "cop_9f8e7d6c5b4a3210", credentialKindUnknown},
		{"empty string", "", credentialKindUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := detectCredentialKind(tt.token); got != tt.want {
				t.Errorf("detectCredentialKind(%q) = %v, want %v", tt.token, got, tt.want)
			}
		})
	}
}

func TestIsOAuthExchangeCredential(t *testing.T) {
	tests := []struct {
		name string
		kind credentialKind
		want bool
	}{
		{"OAuth user token exchanges", credentialKindOAuthUserToken, true},
		{"GitHub App user token exchanges", credentialKindGithubAppUserToken, true},
		{"fine-grained PAT exchanges", credentialKindFineGrainedPAT, true},
		{"unknown does not exchange", credentialKindUnknown, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isOAuthExchangeCredential(tt.kind); got != tt.want {
				t.Errorf("isOAuthExchangeCredential(%v) = %v, want %v", tt.kind, got, tt.want)
			}
		})
	}
}
