# Restaurant companies

Home guild only (`1155236281706627173`), in the existing games channel or its threads. No new rooms, roles or administrative balance corrections are created.

## Member commands

- `شركة إنشاء اسم الشركة`: quote a new restaurant, then confirm its cost with the owner-only button.
- `شركة`, `شركة خزنة`, `شركة تطوير`: company panel, treasury, upgrade choices and payout/cooldown times.
- `شركة سحب 5000`: quote a treasury withdrawal and confirm it. Amounts must be whole CC; partial numbers such as `1.5` or `5000abc` are rejected rather than truncated. Arabic digits are supported. The panel also offers withdrawal of the available treasury.
- `شركات`: top ten company values, current monthly operating profit and recent monthly cups.
- Slash equivalents: `/company view|create|upgrade|treasury|withdraw|leaderboard`.

## Launch economy

These are conservative configurable launch prices based on the existing 50,000 CC palace, **not** an assessment of live member balances. No production balance query is needed to deploy.

| Purchase | Cost in CC |
| --- | --- |
| Create (one company/member) | 100,000 |
| Branches 2, 3, 4, 5 | 150,000; 300,000; 600,000; 1,200,000 |
| Quality 2, 3, 4, 5 | 40,000; 80,000; 160,000; 320,000 |
| Marketing 2, 3, 4, 5 | 30,000; 60,000; 120,000; 240,000 |

All three start at level 1 and cap at 5. The first upgrade is available 24h after creation; every successful upgrade starts a shared 24h cooldown. Upgrade costs consume treasury first, then the explicitly confirmed remainder from the owner's CC wallet. No automatic wallet deductions, debt, bankruptcy, sale, or company transfers.

Effective demand = `min(marketing, branches)`. Daily revenue = `branches × (700 + 100 × quality + 120 × demand)`; operating expenses = `branches × (400 + 50 × quality + 70 × demand)`; daily net profit = revenue − expenses, with a hard configuration ceiling. Starting net is 400 CC/day and the fully developed restaurant nets 4,000 CC/day (below the 6,000 ceiling). The all-upgrade investment including creation is 3,400,000 CC. Prices are permanent sinks; company value is total investment plus treasury, **not** a refundable sale price.

Payouts are each full 24h from creation, rather than a free partial UTC day. Upgrades take effect for the full cycle starting **after the next payout**, so already elapsed time can never earn an upgraded rate. Missed payouts are calculated lazily on access and survive downtime; catch-up iterates calendar months, not days. Opening a panel projects the balance without writing another member's data. A withdrawal or upgrade commits pending profits and its own mutation together. Exact integer CC only.

## Seasons

Operating profit is assigned to the UTC month of its scheduled payout, regardless of when the owner opens the bot. A strict guild-wide read projects every company before finalizing any ended month. Most operating profit wins the immutable `ملك المطاعم` cup; ties use the lowest user ID. No CC, Discord roles or member permissions are awarded. Cups remain in the archive and on the winner's company panel; the ranking panel shows the most recent six. Current monthly ranking resets without resetting companies, investments or treasury. Deleted member economy data is outside this feature; finalized archived results remain unchanged.

## Durability and safeguards

Company data lives in `ccCompany` within the existing economy row. Wallet, treasury, cooldown, company version, payout watermark and month totals are saved in one row write under the **same existing member CC mutex** used by games/store/bourse/transfers. This matches the one-replica deployment; do not run multiple bot copies. No schema migration or import is needed; the existing JSON column retains unrelated holdings, streaks and inventory.

New opt-in strict reads bypass the legacy read-error-to-default behavior. Company operations stop when Postgres is unavailable/degraded, a strict read fails, a write reports failure, a saved company is invalid, or arithmetic overflows. No memory fallback company purchases. The existing economy APIs are otherwise unchanged. A failed or ambiguously committed confirmation is safe to retry because the persisted version prevents executing the same mutation twice.

Quotes are owner/guild/channel bound, expire after five minutes and are kept in a bounded 1,000-entry process map. Quotes expire on restart; ownership, money and cooldown do not. Clicking stale/replayed quotes never repeats a charge. All costs are displayed before confirmation, and balances/cooldowns are checked again under the lock. Names disallow mentions/control characters and output disables mention parsing.

Company buttons also recheck the current base command, Games category and matching subcommand setting. Disabling any of them blocks old confirmations and controls, including moderation confirmations. A failed strict configuration read stops the action. Cancelling an existing quote remains available without a configuration read or financial mutation.

## Validation and launch

Run `node --test tests/companies.test.js tests/companyCommands.test.js`, then `npm test`. Tests use cloned in-memory fake persistent records and mocked SQL; they never connect to Neon or purchase anything with member money. Live read-only smoke: `شركة`, `شركة تطوير` (without confirming), `شركات`. A successful real purchase/withdrawal must be initiated by its owner; do not fabricate test CC or companies on production.

Deploy to the active NEW Railway service only. Keep Wispbyte, HeavenCloud and the old Railway instance stopped. Additive rollback: deploy the preceding release; preserve `ccCompany` and the season archive for re-enabling later. Never clear Neon or re-import member records.

## Names and reversible moderation

Company names use the server's shared insult/banned-word rules plus explicit adult/child sexual-content terms, both before a creation/restoration quote and again inside the locked mutation. The name policy applies to every member, including Trusted users, managers, guild owners and bot owners. Ordinary chat exemptions and punishments remain unchanged. Policy normalization covers Arabic accents, tatweel, common letter variants, formatting/invisible marks and punctuation, plus obvious English spacing and leetspeak variants. Split word chunks are checked without treating innocent substrings such as `Essex` as explicit words. This is a targeted rule, not a guarantee that every offensive phrase in every language is detected. Ordinary family/children's restaurant names remain permitted. Saved-data validation stays structural so previously accepted names can still be moderated; blocked names are replaced by a generic label in new panels/rankings.

Server managers (`ManageGuild`), the guild owner and configured bot owners may use:

- `شركة إيقاف @member` or `/company archive member`: preview a reversible removal, then confirm. Only the targeted company is archived. Its wallet, investment, earned treasury, historical profit and all unrelated fields are preserved; no refund, deduction or role change occurs.
- `شركة استرجاع @member safe name` or `/company restore member name`: restore the archive with a safe name. Treasury/development/history remain, but payout and upgrade timers restart at 24h, with no earnings for suspended downtime.

Permission is fetched again at confirmation and rechecked under the target member's existing CC mutex. Quotes bind manager, member, guild, version and expiry; duplicate/stale requests cannot apply twice. Archived owners cannot create a replacement, withdraw or upgrade. Archives do not appear in current value/monthly rankings or earn additional profit; legitimately earned historical monthly totals remain eligible when finalizing ended seasons. Slash creation/moderation previews are private; normal prefix replies retain their existing visibility. Old Discord messages are not deleted or edited by this storage operation.
