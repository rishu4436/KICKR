-- Phase 2 football domain. Additive. Does not alter Phase 1 identity tables.
-- Credits are an integer squad budget. There is no escrow, balance, or payout column.
-- The Solana escrow program still does not exist.
-- DEV_V1 below is a development scoring ruleset, not the production contract.

CREATE TABLE clubs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT clubs_provider_id_unique UNIQUE (provider_id)
);

CREATE TABLE player_roles (
  code text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_roles_known CHECK (code IN ('GK', 'DEF', 'MID', 'FWD'))
);

INSERT INTO player_roles (code) VALUES ('GK'), ('DEF'), ('MID'), ('FWD');

CREATE TABLE players (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  short_name text NOT NULL,
  position text NOT NULL REFERENCES player_roles (code),
  club_id uuid NOT NULL REFERENCES clubs (id),
  active boolean NOT NULL,
  provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT players_provider_id_unique UNIQUE (provider_id)
);

CREATE INDEX players_club_id_idx ON players (club_id);

CREATE TABLE matches (
  id uuid PRIMARY KEY,
  home_club_id uuid NOT NULL REFERENCES clubs (id),
  away_club_id uuid NOT NULL REFERENCES clubs (id),
  kickoff_at timestamptz NOT NULL,
  competition text NOT NULL,
  venue text NULL,
  external_fixture_id text NOT NULL,
  status text NOT NULL,
  lineup_available boolean NOT NULL,
  data_source jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matches_distinct_clubs CHECK (home_club_id <> away_club_id),
  CONSTRAINT matches_external_fixture_unique UNIQUE (external_fixture_id),
  CONSTRAINT matches_status_known CHECK (status IN (
    'SCHEDULED',
    'LINEUPS_AVAILABLE',
    'LOCKED',
    'LIVE',
    'HALFTIME',
    'FULL_TIME',
    'DATA_FINALIZING',
    'FINAL',
    'POSTPONED',
    'CANCELLED',
    'ABANDONED',
    'VOID'
  )),
  CONSTRAINT matches_data_source_object CHECK (jsonb_typeof(data_source) = 'object')
);

CREATE INDEX matches_kickoff_idx ON matches (kickoff_at);
CREATE INDEX matches_status_idx ON matches (status);

COMMENT ON TABLE matches IS
  'Internal match id is the primary key. external_fixture_id is a provider reference. Status changes must go through the match state machine, not an arbitrary setter.';

CREATE TABLE match_squad (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id),
  player_id uuid NOT NULL REFERENCES players (id),
  club_id uuid NOT NULL REFERENCES clubs (id),
  fantasy_position text NOT NULL REFERENCES player_roles (code),
  credit_value bigint NOT NULL,
  availability text NOT NULL,
  starting_status text NOT NULL,
  squad_status text NOT NULL,
  provider_id text NOT NULL,
  source_version text NOT NULL,
  sourced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_squad_player_once UNIQUE (match_id, player_id),
  CONSTRAINT match_squad_credit_nonnegative CHECK (credit_value >= 0),
  CONSTRAINT match_squad_availability_known CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE', 'UNKNOWN')),
  CONSTRAINT match_squad_starting_known CHECK (starting_status IN ('STARTER', 'BENCH', 'UNKNOWN')),
  CONSTRAINT match_squad_status_known CHECK (squad_status IN ('INCLUDED', 'EXCLUDED'))
);

CREATE INDEX match_squad_match_idx ON match_squad (match_id);

COMMENT ON COLUMN match_squad.credit_value IS
  'Integer squad credits. Not a currency balance.';

CREATE TABLE fantasy_teams (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT fantasy_teams_status_known CHECK (status IN ('DRAFT', 'LOCKED'))
);

CREATE INDEX fantasy_teams_account_idx ON fantasy_teams (account_id);
CREATE INDEX fantasy_teams_match_idx ON fantasy_teams (match_id);

COMMENT ON TABLE fantasy_teams IS
  'Latest status is DRAFT or LOCKED. Version history is a separate append-only table. TODO: one team per account per match is unspecified. TODO: kickoff auto-lock is not implemented.';

CREATE TABLE fantasy_team_versions (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES fantasy_teams (id),
  version integer NOT NULL,
  match_id uuid NOT NULL REFERENCES matches (id),
  player_ids uuid[] NOT NULL,
  captain_id uuid NOT NULL,
  vice_id uuid NOT NULL,
  credits_used bigint NOT NULL,
  validation_result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT fantasy_team_versions_unique UNIQUE (team_id, version),
  CONSTRAINT fantasy_team_versions_positive CHECK (version >= 1),
  CONSTRAINT fantasy_team_versions_xi CHECK (cardinality(player_ids) = 11),
  CONSTRAINT fantasy_team_versions_credits CHECK (credits_used >= 0),
  CONSTRAINT fantasy_team_versions_result_object CHECK (jsonb_typeof(validation_result) = 'object')
);

CREATE INDEX fantasy_team_versions_team_idx ON fantasy_team_versions (team_id, version);

COMMENT ON TABLE fantasy_team_versions IS
  'Append-only. Every save inserts a new version. Do not update or delete history.';

CREATE TABLE scoring_rulesets (
  id uuid PRIMARY KEY,
  version integer NOT NULL,
  name text NOT NULL,
  effective_from timestamptz NOT NULL,
  event_weights jsonb NOT NULL,
  captain_numerator integer NOT NULL,
  captain_denominator integer NOT NULL,
  vice_numerator integer NOT NULL,
  vice_denominator integer NOT NULL,
  rounding_policy text NOT NULL,
  scale integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scoring_rulesets_version_unique UNIQUE (name, version),
  CONSTRAINT scoring_rulesets_scale_positive CHECK (scale > 0),
  CONSTRAINT scoring_rulesets_denominators CHECK (captain_denominator > 0 AND vice_denominator > 0),
  CONSTRAINT scoring_rulesets_weights_object CHECK (jsonb_typeof(event_weights) = 'object'),
  CONSTRAINT scoring_rulesets_status_known CHECK (status IN ('DEVELOPMENT', 'RETIRED'))
);

COMMENT ON TABLE scoring_rulesets IS
  'DEV_V1 is development-only. Status DEVELOPMENT must not be treated as the production scoring contract. Weights are integer milli-points.';

INSERT INTO scoring_rulesets (
  id, version, name, effective_from, event_weights,
  captain_numerator, captain_denominator, vice_numerator, vice_denominator,
  rounding_policy, scale, status
) VALUES (
  '40000000-0000-4000-8000-000000000001',
  1,
  'DEV_V1',
  '2026-01-01T00:00:00Z',
  '{
    "GOAL": 5000,
    "ASSIST": 3000,
    "SHOT": 0,
    "SHOT_ON_TARGET": 1000,
    "KEY_PASS": 0,
    "TACKLE": 0,
    "INTERCEPTION": 0,
    "CLEARANCE": 0,
    "SAVE": 0,
    "CORNER_WON": 1000,
    "FOUL_COMMITTED": 0,
    "YELLOW_CARD": -1000,
    "RED_CARD": 0,
    "OWN_GOAL": 0,
    "SUBSTITUTION": 0,
    "PENALTY_MISS": 0,
    "PENALTY_SAVE": 0,
    "GOAL_CONCEDED": 0,
    "VAR_REVERSAL": 0
  }'::jsonb,
  2, 1, 3, 2,
  'TOWARD_ZERO',
  1000,
  'DEVELOPMENT'
);

CREATE TABLE match_events (
  event_id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  sequence integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  match_minute integer NULL,
  period text NULL,
  event_type text NOT NULL,
  primary_player_id uuid NULL REFERENCES players (id),
  secondary_player_id uuid NULL REFERENCES players (id),
  team_id uuid NULL REFERENCES clubs (id),
  metadata jsonb NOT NULL,
  supersedes_event_id uuid NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT match_events_provider_event_unique UNIQUE (provider, provider_event_id),
  CONSTRAINT match_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT match_events_type_known CHECK (event_type IN (
    'GOAL',
    'ASSIST',
    'SHOT',
    'SHOT_ON_TARGET',
    'KEY_PASS',
    'TACKLE',
    'INTERCEPTION',
    'CLEARANCE',
    'SAVE',
    'CORNER_WON',
    'FOUL_COMMITTED',
    'YELLOW_CARD',
    'RED_CARD',
    'OWN_GOAL',
    'SUBSTITUTION',
    'PENALTY_MISS',
    'PENALTY_SAVE',
    'GOAL_CONCEDED',
    'VAR_REVERSAL'
  ))
);

CREATE INDEX match_events_match_seq_idx ON match_events (match_id, sequence);
CREATE INDEX match_events_supersedes_idx ON match_events (supersedes_event_id);

COMMENT ON TABLE match_events IS
  'Immutable. Corrections are new rows with supersedes_event_id. Historical rows are never updated.';

ALTER TABLE match_events
  ADD CONSTRAINT match_events_supersedes_fk
  FOREIGN KEY (supersedes_event_id) REFERENCES match_events (event_id);

CREATE TRIGGER clubs_set_updated_at
  BEFORE UPDATE ON clubs
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER player_roles_set_updated_at
  BEFORE UPDATE ON player_roles
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER players_set_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER matches_set_updated_at
  BEFORE UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER match_squad_set_updated_at
  BEFORE UPDATE ON match_squad
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER fantasy_teams_set_updated_at
  BEFORE UPDATE ON fantasy_teams
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER scoring_rulesets_set_updated_at
  BEFORE UPDATE ON scoring_rulesets
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE OR REPLACE FUNCTION kickr_forbid_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'fantasy_team_versions is append-only; % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fantasy_team_versions_no_update
  BEFORE UPDATE ON fantasy_team_versions
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_version_mutation();

CREATE TRIGGER fantasy_team_versions_no_delete
  BEFORE DELETE ON fantasy_team_versions
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_version_mutation();

REVOKE UPDATE, DELETE ON fantasy_team_versions FROM PUBLIC;

CREATE OR REPLACE FUNCTION kickr_forbid_match_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match_events is append-only; % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER match_events_no_update
  BEFORE UPDATE ON match_events
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_match_event_mutation();

CREATE TRIGGER match_events_no_delete
  BEFORE DELETE ON match_events
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_match_event_mutation();

REVOKE UPDATE, DELETE ON match_events FROM PUBLIC;
