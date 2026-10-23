-- ---------------------------------------------------------- outbox delivery
--
-- The outbox already had the states; it was missing everything needed to
-- deliver a message safely. Three additions, each fixing a specific failure:
--
--   claimed_at   A row marked 'claimed' with no timestamp is a row nobody can
--                tell is stuck. If the process dies mid-send, the message sits
--                in 'claimed' forever and the client is never chased. With a
--                timestamp, a claim older than the lease can be reclaimed.
--
--   provider_id  The id the channel returned. Without it, "did this actually
--                send?" is unanswerable after the fact — the same gap that makes
--                people distrust automated invoicing. With it, a delivery can be
--                looked up at the provider.
--
--   idempotency  The single most dangerous failure in a chaser is sending the
--                same demand twice. A retry after an ambiguous timeout (the
--                provider got it, the response was lost) must be recognisable as
--                the same message, not a new one. The key is derived from the
--                reminder, so a retry carries the identical key and a provider
--                that supports it collapses the duplicate.

ALTER TABLE outbox_message ADD COLUMN claimed_at INTEGER;
ALTER TABLE outbox_message ADD COLUMN provider_id TEXT;
ALTER TABLE outbox_message ADD COLUMN idempotency_key TEXT;
ALTER TABLE outbox_message ADD COLUMN sent_at INTEGER;

-- Every existing row gets a stable key derived from its reminder, so a message
-- queued before this migration is still de-duplicable after it.
UPDATE outbox_message
   SET idempotency_key = 'dun-' || COALESCE(reminder_id, id) || '-' || id
 WHERE idempotency_key IS NULL;

CREATE UNIQUE INDEX outbox_idempotency ON outbox_message (idempotency_key);
CREATE INDEX outbox_claimed ON outbox_message (state, claimed_at);
