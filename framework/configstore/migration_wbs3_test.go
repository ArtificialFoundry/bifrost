package configstore

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMigrationAddGithubCopilotOAuthKeyConfigColumn_Idempotent pins that the migration
// is safe to run twice (WBS 3.2 requirement): the second run must be a no-op, not an error.
func TestMigrationAddGithubCopilotOAuthKeyConfigColumn_Idempotent(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()

	require.NoError(t, db.AutoMigrate(&tables.TableProvider{}, &tables.TableKey{}))
	require.NoError(t, db.Migrator().DropColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))
	require.False(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))

	require.NoError(t, migrationAddGithubCopilotOAuthKeyConfigColumn(ctx, db, testMigrationLogger))
	require.True(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))

	// Second run must not error.
	require.NoError(t, migrationAddGithubCopilotOAuthKeyConfigColumn(ctx, db, testMigrationLogger))
	require.True(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))
}

// TestMigrationAddGithubCopilotOAuthKeyConfigColumn_NonRollbackable pins the refuse-to-drop
// rollback behavior, mirroring rollbackGithubCopilotConfigColumns for the App-JWT columns.
func TestMigrationAddGithubCopilotOAuthKeyConfigColumn_NonRollbackable(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()

	require.NoError(t, db.AutoMigrate(&tables.TableProvider{}, &tables.TableKey{}))
	require.NoError(t, db.Migrator().DropColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))
	require.NoError(t, migrationAddGithubCopilotOAuthKeyConfigColumn(ctx, db, testMigrationLogger))

	seed := &tables.TableKey{
		Name:       "copilot-oauth-rollback",
		ProviderID: 1,
		Provider:   "copilot",
		KeyID:      "copilot-oauth-rollback-1",
		GithubCopilotOAuthKeyConfig: &schemas.GithubCopilotOAuthKeyConfig{
			AccessToken: *schemas.NewSecretVar("gho_liveDeviceFlowToken"),
		},
	}
	require.NoError(t, db.Create(seed).Error)

	err := rollbackGithubCopilotOAuthKeyConfigColumn(db)
	require.Error(t, err, "rollback must refuse: dropping the column destroys an unrecoverable OAuth access token")
	assert.Contains(t, err.Error(), "non-rollbackable")
	assert.True(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"),
		"a refused rollback must leave the column intact")

	var got tables.TableKey
	require.NoError(t, db.Where("key_id = ?", seed.KeyID).First(&got).Error)
	require.NotNil(t, got.GithubCopilotOAuthKeyConfig)
	assert.Equal(t, "gho_liveDeviceFlowToken", got.GithubCopilotOAuthKeyConfig.AccessToken.GetValue(),
		"the access token must survive the refused rollback")
}

// TestMigrationAddGithubCopilotOAuthKeyConfigColumn_LiveRowUnchanged is WBS 3.3's dry-run:
// a synthetic DB seeded with a row shaped exactly like prod's live config_providers id=5
// ("agent47nh", provider="copilot") paired with a config_keys row holding a gho_-prefixed
// legacy Value (no typed OAuth field populated, since that field didn't exist for this row
// pre-migration). It applies the forward migration and asserts, via an explicit
// before/after JSON diff, that the row is untouched except for the new column appearing as
// null -- confirming WBS 3.1's design claim that the live row needs zero mutation.
func TestMigrationAddGithubCopilotOAuthKeyConfigColumn_LiveRowUnchanged(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()

	require.NoError(t, db.AutoMigrate(&tables.TableProvider{}, &tables.TableKey{}))
	// Simulate pre-migration schema: drop the column this migration is responsible for adding.
	require.NoError(t, db.Migrator().DropColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))
	require.False(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))

	// Seed prod-shaped rows: config_providers id=5 name='agent47nh' provider='copilot',
	// paired config_keys row with a gho_-prefixed OAuth token in the legacy Value field.
	provider := &tables.TableProvider{
		ID:   5,
		Name: "agent47nh",
	}
	require.NoError(t, db.Create(provider).Error)
	require.EqualValues(t, uint(5), provider.ID, "seed must reproduce prod's id=5 for a faithful dry-run")

	key := &tables.TableKey{
		Name:       "agent47nh-key",
		ProviderID: provider.ID,
		Provider:   "copilot",
		KeyID:      "agent47nh-key-1",
		Value:      *schemas.NewSecretVar("gho_prodLiveOAuthTokenDoNotRotate"),
	}
	// Insert via raw SQL naming only the pre-migration column set (the column under test
	// is physically absent at this point) -- db.Create always emits every column GORM's
	// cached schema knows about regardless of what Migrator dropped, so it cannot be used
	// here to reproduce a genuinely pre-migration row.
	require.NoError(t, db.Exec(
		`INSERT INTO config_keys (name, provider_id, provider, key_id, value, enabled, use_for_batch_api, use_anthropic_endpoints, status, encryption_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		key.Name, key.ProviderID, key.Provider, key.KeyID, key.Value.GetValue(), true, false, false, "unknown", "plain_text",
	).Error)

	// Capture "before" state as JSON (re-fetched from DB, not the in-memory struct, so
	// AfterFind round-tripping is exercised identically to "after").
	var before tables.TableKey
	require.NoError(t, db.Where("key_id = ?", key.KeyID).First(&before).Error)
	beforeJSON, err := json.MarshalIndent(before, "", "  ")
	require.NoError(t, err)

	// Apply the forward migration under test.
	require.NoError(t, migrationAddGithubCopilotOAuthKeyConfigColumn(ctx, db, testMigrationLogger))
	require.True(t, db.Migrator().HasColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))

	var after tables.TableKey
	require.NoError(t, db.Where("key_id = ?", key.KeyID).First(&after).Error)
	afterJSON, err := json.MarshalIndent(after, "", "  ")
	require.NoError(t, err)

	t.Logf("BEFORE migration (config_keys id=%d, key_id=%s):\n%s", before.ID, before.KeyID, beforeJSON)
	t.Logf("AFTER migration (config_keys id=%d, key_id=%s):\n%s", after.ID, after.KeyID, afterJSON)

	// The evidence: before == after as JSON. The new column has no runtime-visible json
	// tag effect when nil (omitempty on GithubCopilotOAuthKeyConfig), so a byte-identical
	// diff on the two structs is the correct proof that nothing about the live row's
	// resolvable state changed.
	assert.JSONEq(t, string(beforeJSON), string(afterJSON),
		"the live agent47nh row must be byte-for-byte unchanged after the migration")

	// Explicit, itemized assertions per the STOP CONDITION's evidence bar.
	assert.Equal(t, "copilot", after.Provider, "provider string must NOT be rewritten -- the code-side alias (commit 3505af727) handles resolution")
	assert.Equal(t, "gho_prodLiveOAuthTokenDoNotRotate", after.Value.GetValue(), "the legacy OAuth token in Value must be unchanged")
	assert.Equal(t, provider.ID, after.ProviderID, "key-to-provider linkage must be unchanged")
	assert.Nil(t, after.GithubCopilotOAuthKeyConfig, "no typed OAuth config should be synthesized for a pre-existing legacy row -- it must keep resolving via the Value fallback in core/providers/copilot")

	// Confirm the raw column itself, not just the reconstructed struct, is NULL --
	// i.e. this migration performed no backfill.
	var rawValue *string
	require.NoError(t, db.Raw("SELECT github_copilot_oauth_access_token FROM config_keys WHERE key_id = ?", key.KeyID).Scan(&rawValue).Error)
	assert.Nil(t, rawValue, "the new column must be NULL for the pre-existing row -- no data migration/backfill performed")
}

// TestMigrationAddGithubCopilotOAuthKeyConfigColumn_ResolvesViaSchemaKey is WBS 5.3's
// migration-safety test: it seeds a row shaped like a NEW key created after this
// migration (i.e. actually populating the new typed column, not the legacy Value
// fallback covered by _LiveRowUnchanged above), applies the migration, and exercises the
// real DB-row -> schemas.Key conversion path (schemaKeyFromTableKey) that
// core/providers/githubcopilot.resolveCredentials / core/providers/copilot actually
// consume at request time -- not just "the row exists in the table."
func TestMigrationAddGithubCopilotOAuthKeyConfigColumn_ResolvesViaSchemaKey(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()

	require.NoError(t, db.AutoMigrate(&tables.TableProvider{}, &tables.TableKey{}))
	require.NoError(t, db.Migrator().DropColumn(&tables.TableKey{}, "github_copilot_oauth_access_token"))
	require.NoError(t, migrationAddGithubCopilotOAuthKeyConfigColumn(ctx, db, testMigrationLogger))

	provider := &tables.TableProvider{Name: "copilot-oauth-new"}
	require.NoError(t, db.Create(provider).Error)

	seed := &tables.TableKey{
		Name:       "copilot-oauth-new-key",
		ProviderID: provider.ID,
		Provider:   "copilot",
		KeyID:      "copilot-oauth-new-key-1",
		Enabled:    boolPtr(true),
		GithubCopilotOAuthKeyConfig: &schemas.GithubCopilotOAuthKeyConfig{
			AccessToken: *schemas.NewSecretVar("gho_newlyCreatedPostMigrationToken"),
		},
	}
	require.NoError(t, db.Create(seed).Error)

	// Re-fetch through the real GORM round trip (AfterFind reconstructs
	// GithubCopilotOAuthKeyConfig from the new column, exactly as production does).
	var dbKey tables.TableKey
	require.NoError(t, db.Where("key_id = ?", seed.KeyID).First(&dbKey).Error)
	require.NotNil(t, dbKey.GithubCopilotOAuthKeyConfig,
		"AfterFind must reconstruct the typed OAuth config from the new column")
	assert.Equal(t, "gho_newlyCreatedPostMigrationToken", dbKey.GithubCopilotOAuthKeyConfig.AccessToken.GetValue())

	// This is the exact conversion function every configstore read path (GetProviderKey,
	// GetProviderKeys, etc.) calls before handing a schemas.Key to the provider layer.
	schemaKey := schemaKeyFromTableKey(dbKey)

	// BUG: schemaKeyFromTableKey does not map GithubCopilotOAuthKeyConfig from the
	// DB-reconstructed tables.TableKey onto the returned schemas.Key at all (confirmed by
	// reading configstore/rdb.go:146-171 -- every other *KeyConfig field for other
	// providers, e.g. AzureKeyConfig/VertexKeyConfig/GithubCopilotKeyConfig, is copied
	// across, but GithubCopilotOAuthKeyConfig is missing from that struct literal).
	// core/providers/githubcopilot.resolveCredentials only ever sees the schemas.Key this
	// function returns, so for a NEW key created after this migration that only populates
	// the typed OAuth column (no legacy Value), that credential is currently unreachable
	// at request time even though the DB row is correct end-to-end. This assertion
	// currently FAILS and documents the gap; it must not be "fixed" here per this task's
	// STOP CONDITION -- report to subagent-2/subagent-1 (configstore/rdb.go owner) instead.
	assert.NotNil(t, schemaKey.GithubCopilotOAuthKeyConfig,
		"BUG (report, do not patch here): schemaKeyFromTableKey (configstore/rdb.go) omits "+
			"GithubCopilotOAuthKeyConfig, so a key created after this migration using only the "+
			"new typed OAuth column resolves to schemas.Key{} with that field nil -- "+
			"copilot.HasOAuthCredential(schemaKey) will be false and the request falls through "+
			"to the bare-token/no-credentials error path instead of exchanging the OAuth token")
}

func boolPtr(b bool) *bool { return &b }
