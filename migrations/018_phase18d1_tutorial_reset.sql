-- Phase 18D.1: allow Tutorial Match (DEMO provider only) to reset events + status.
-- Sportmonks / LIVE match_events remain append-only and untouched.
-- Function runs as owner so it can disable the no-delete trigger for demo rows only.

CREATE OR REPLACE FUNCTION kickr_reset_tutorial_match(p_match_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_provider text;
BEGIN
  SELECT data_source->>'provider' INTO v_provider FROM matches WHERE id = p_match_id;
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'match not found';
  END IF;
  IF v_provider <> 'demo' THEN
    RAISE EXCEPTION 'kickr_reset_tutorial_match refuses non-demo match (provider=%)', v_provider;
  END IF;

  ALTER TABLE match_events DISABLE TRIGGER match_events_no_delete;
  ALTER TABLE match_events DISABLE TRIGGER match_events_no_update;
  BEGIN
    DELETE FROM match_events WHERE match_id = p_match_id AND provider = 'demo';
  EXCEPTION WHEN OTHERS THEN
    ALTER TABLE match_events ENABLE TRIGGER match_events_no_delete;
    ALTER TABLE match_events ENABLE TRIGGER match_events_no_update;
    RAISE;
  END;
  ALTER TABLE match_events ENABLE TRIGGER match_events_no_delete;
  ALTER TABLE match_events ENABLE TRIGGER match_events_no_update;

  UPDATE matches
  SET status = 'LINEUPS_AVAILABLE',
      lineup_available = true,
      competition = 'Tutorial Match',
      data_source = jsonb_set(
        COALESCE(data_source, '{}'::jsonb),
        '{label}',
        to_jsonb('SIMULATED — Tutorial Match (fictional clubs/players, not Sportmonks, not a live feed)'::text),
        true
      )
  WHERE id = p_match_id
    AND data_source->>'provider' = 'demo';
END;
$$;

COMMENT ON FUNCTION kickr_reset_tutorial_match(uuid) IS
  'Tutorial Match only: delete DEMO provider events and reset status to LINEUPS_AVAILABLE. Refuses Sportmonks.';
