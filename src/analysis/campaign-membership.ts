/**
 * X campaign membership — keeps campaign lifecycle status in sync.
 * See docs/scope-x-campaigns.md (decisions 3, 8) and CONTEXT.md ("Campaign",
 * "Anchor post"). Membership itself is manual-only: Track by X link or
 * add-by-id (POST /api/campaigns/:id/posts), both of which set
 * campaign_locked=true. Auto-claiming by hashtag was removed — a hashtag can
 * appear on unrelated content, which was misattributing posts.
 */
import { socialQuery } from '../db/social-client';

/**
 * Keeps campaigns.status in sync with the clock. Idempotent — safe to call on
 * every cron tick:
 *   - now within [starts_at, ends_at + 3 days]      -> 'active'
 *   - now  > ends_at + 3 days                       -> 'ended'
 *   - ends_at IS NULL ("ongoing") + now >= starts_at -> 'active', never auto-ends
 *   - otherwise (before starts_at)                   -> left as 'draft'
 *
 * 'ended' is terminal: the activation clause below excludes it, so a campaign
 * a human force-ends early via PATCH (status='ended') never gets reactivated
 * by this sync even if `now` is still inside its window. The schema's status
 * CHECK only allows draft|active|ended (no separate "ended-by-user" value).
 * An ongoing campaign only leaves 'active' when a human sets ends_at (next
 * sync tick then applies the normal ended rule) or force-ends it via PATCH.
 */
export async function syncCampaignStatuses(): Promise<{ activated: number; ended: number }> {
  const activated = await socialQuery<{ id: number }>(
    `UPDATE campaigns
     SET status = 'active'
     WHERE status NOT IN ('active', 'ended')
       AND starts_at IS NOT NULL
       AND NOW() >= starts_at
       AND (ends_at IS NULL OR NOW() <= ends_at + INTERVAL '3 days')
     RETURNING id`,
  );
  const ended = await socialQuery<{ id: number }>(
    `UPDATE campaigns
     SET status = 'ended'
     WHERE status = 'active'
       AND ends_at IS NOT NULL
       AND NOW() > ends_at + INTERVAL '3 days'
     RETURNING id`,
  );
  return { activated: activated.length, ended: ended.length };
}
