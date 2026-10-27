import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { ccEmbed, formatCC } from '../../config/cc.js';
import { COMPANY, COMPANY_UPGRADES, companyDaily, companyUpgradeCost } from '../../config/store/companies.js';
import { companyValue, getCompany, companyLeaderboard } from './companyService.js';
import { companyNameIssue, publicCompanyName } from './companyNames.js';
import { companyModerationState } from './companyModeration.js';

export const COMPANY_BUTTON_PREFIX = 'company';
const quotes = new Map();
const safe = (name) => escapeMarkdown(name);
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`company:${id}`).setLabel(label).setStyle(style);
const row = (...buttons) => new ActionRowBuilder().addComponents(buttons);
const payload = (embeds, components = [], content = '') => ({ content, embeds, components, allowedMentions: { parse: [] } });
const relative = (time) => `<t:${Math.floor(time / 1000)}:R>`;

export function companyFailureText(result) {
    return ({
        owned: '🏢 عندك شركة بالفعل. اكتب `شركة`.',
        missing: '🏢 معندكش شركة. اكتب `شركة إنشاء اسم الشركة`.',
        name: '✏️ الاسم من 2 لـ32 حرف: حروف وأرقام ومسافات أو . _ - بس.',
        forbidden_name: '🚫 الاسم ده ممنوع. اختار اسم محترم ومناسب للشركة؛ مفيش عملية اتنفذت.',
        archived: '⛔ الشركة موقوفة إداريًا. الأرباح والتعاملات متوقفة؛ كلم الإدارة لاسترجاعها باسم مناسب.',
        not_archived: '🏢 الشركة دي مش موقوفة.',
        permission: '❌ إدارة الشركات محتاجة صلاحية إدارة السيرفر.',
        no_cc: '💰 الفلوس مش كفاية. التطوير بياخد من خزنة الشركة الأول، والباقي من رصيدك.',
        treasury: '💰 المبلغ أكبر من اللي في خزنة الشركة.',
        amount: '✏️ اكتب مبلغ صحيح أكبر من صفر، مثال: `شركة سحب 5000`.',
        max: '✅ التطوير ده وصل للمستوى الخامس.',
        cooldown: `⏳ تقدر تطوّر تاني ${relative(result.until || Date.now())}.`,
        stale: '🔄 بيانات الشركة اتغيرت. افتح `شركة` واطلب العملية من جديد؛ مفيش فلوس اتخصمت.',
        expired: '⌛ التأكيد انتهى أو البوت اتعمله ريستارت. اطلب العملية من جديد.',
        invalid: '❌ العملية دي مش متاحة.',
    })[result.reason] || '❌ مقدرتش أنفّذ العملية. جرّب تاني من لوحة الشركة.';
}

export function companyConfirmation(guildId, userId, details, { now = Date.now() } = {}) {
    // Only bounded, short-lived quotes live in memory. All actual ownership, balances,
    // payouts/cooldowns and transaction replay protection are persisted in the member row.
    for (const [id, quote] of quotes) if (quote.expiresAt <= now) quotes.delete(id);
    while (quotes.size >= 1000) quotes.delete(quotes.keys().next().value);
    const id = randomUUID();
    const quote = { ...details, guildId, userId, expiresAt: now + COMPANY.quoteMs };
    quotes.set(id, quote);
    let text;
    if (details.action === 'create') text = `هتنشئ مطعم **${safe(details.name)}** مقابل ${formatCC(details.cost)} من رصيدك.\nأول ربح بعد 24 ساعة، وأول تطوير بعد 24 ساعة.`;
    else if (details.action === 'upgrade') text = `هتطوّر **${COMPANY_UPGRADES[details.kind]}** مقابل ${formatCC(details.cost)}.\nمن الخزنة: ${formatCC(Math.min(details.treasury, details.cost))}، ومن رصيدك: ${formatCC(Math.max(0, details.cost - details.treasury))}.\nالتطوير يأثر على دورة الربح اللي تبدأ بعد الدفعة الجاية. بين كل تطوير والتاني 24 ساعة.`;
    else if (details.action === 'archive') text = `هتوقف شركة <@${details.targetId}> وتخفيها من الترتيب. الأرباح هتقف، والبيانات هتفضل محفوظة للاسترجاع.\nمفيش رد أو خصم CC؛ رصيد العضو وخزنة الشركة محفوظين.`;
    else if (details.action === 'restore') text = `هترجع شركة <@${details.targetId}> باسم **${safe(details.name)}**.\nالخزنة والتطويرات القديمة محفوظة؛ مفيش أرباح عن فترة الإيقاف، والدفعة والتطوير الجايين بعد 24 ساعة. مفيش رد أو خصم CC.`;
    else text = `هتسحب ${formatCC(details.amount)} من خزنة شركتك لرصيدك. ده نقل للربح الموجود، مش ربح إضافي.`;
    return payload([ccEmbed('✅ تأكيد عملية الشركة', `${text}\n\nالتأكيد صالح 5 دقايق.`)], [row(
        button(`confirm:${id}`, 'تأكيد العملية', ButtonStyle.Success), button(`cancel:${id}`, 'إلغاء'),
    )]);
}

export function getCompanyQuote(id) { return quotes.get(id); }
export function deleteCompanyQuote(id) { quotes.delete(id); }

export async function companyPanel(client, guildId, userId, { now = Date.now(), notice = '' } = {}) {
    const { company, balance, archived } = await getCompany(client, guildId, userId, { now });
    if (archived) return payload([ccEmbed('⛔ الشركة موقوفة', companyFailureText({ reason: 'archived' }))]);
    if (!company) return payload([ccEmbed('🏢 شركتك', [
        `ابدأ مطعم باسمك مقابل ${formatCC(COMPANY.createCost)}.`,
        '`شركة إنشاء اسم الشركة` ← يعرض التكلفة وبعدين تأكد بزرار.',
        'شركة واحدة لكل شخص؛ 5 فروع و5 مستويات للجودة والتسويق.',
        'الأرباح كل 24 ساعة في خزنة الشركة. مفيش ديون أو خصم تشغيل من رصيدك.',
        '`شركات` ← ترتيب القيمة والشهر والكؤوس.',
        `💰 رصيدك: ${formatCC(balance)}`,
    ].join('\n\n'))]);
    const daily = company.rate;
    const next = companyDaily(company);
    const seasons = await client.db.getStrict(`guild:${guildId}:company-seasons`, {});
    const cups = Object.entries(seasons).filter(([, result]) => result.userId === userId).sort(([a], [b]) => b.localeCompare(a));
    const embed = ccEmbed(`🏢 ${safe(publicCompanyName(company.name))}`, [
        notice,
        `🍽️ الفروع **${company.branches}/5** • الجودة **${company.quality}/5** • التسويق **${company.marketing}/5**`,
        `📊 الدورة الحالية: مبيعات ${formatCC(daily.revenue)} − تشغيل ${formatCC(daily.expenses)} = صافي ${formatCC(daily.profit)}`,
        `⏰ الدفعة الجاية ${relative(company.nextPayoutAt)}؛ صافي الدورة اللي بعدها ${formatCC(next.profit)}.`,
        `💼 الخزنة: ${formatCC(company.treasury)} • رصيدك: ${formatCC(balance)}`,
        `💎 قيمة الشركة: ${formatCC(companyValue(company))} (الاستثمار + الخزنة؛ مش سعر بيع).`,
        `🔧 ${company.upgradeAt > now ? `التطوير الجاي ${relative(company.upgradeAt)}` : 'التطوير متاح دلوقتي'}. التسويق بيستفيد بحد أقصى عدد الفروع.`,
        `💵 التطويرات: ${Object.entries(COMPANY_UPGRADES).map(([kind, name]) => `${name}: ${companyUpgradeCost(company, kind) === null ? 'مكتمل' : formatCC(companyUpgradeCost(company, kind))}`).join(' • ')}`,
        `🏆 كؤوسك: **${cups.length}**${cups.length ? ` • ملك المطاعم ${cups[0][0]}` : ''}`,
        '`شركة تطوير` ← التكلفة • `شركة خزنة` ← الخزنة • `شركة سحب 5000` ← سحب بتأكيد • `شركات` ← الترتيب',
    ].filter(Boolean).join('\n\n'));
    return payload([embed], [row(
        ...Object.entries(COMPANY_UPGRADES).map(([kind, name]) => button(`upgrade:${kind}:${userId}`, `${name}${companyUpgradeCost(company, kind) === null ? ' ✓' : ''}`).setDisabled(companyUpgradeCost(company, kind) === null)),
        button(`refresh:${userId}`, 'تحديث'), button(`withdraw:${userId}`, 'سحب الخزنة'),
    )]);
}

export async function quoteCompanyAction(client, guildId, userId, details, { now = Date.now() } = {}) {
    const { company, version, archived } = await getCompany(client, guildId, userId, { now });
    if (archived) return payload([], [], companyFailureText({ reason: 'archived' }));
    if (details.action === 'create') {
        if (company) return payload([], [], companyFailureText({ reason: 'owned' }));
        const issue = companyNameIssue(details.name);
        if (issue) return payload([], [], companyFailureText({ reason: issue }));
        return companyConfirmation(guildId, userId, { ...details, version, cost: COMPANY.createCost }, { now });
    }
    if (!company) return payload([], [], companyFailureText({ reason: 'missing' }));
    if (companyNameIssue(company.name)) return payload([], [], companyFailureText({ reason: 'forbidden_name' }));
    if (details.action === 'upgrade') {
        const cost = companyUpgradeCost(company, details.kind);
        if (cost === null) return payload([], [], companyFailureText({ reason: 'max' }));
        if (company.upgradeAt > now) return payload([], [], companyFailureText({ reason: 'cooldown', until: company.upgradeAt }));
        return companyConfirmation(guildId, userId, { ...details, version, cost, treasury: company.treasury }, { now });
    }
    const amount = details.amount === 'all' ? company.treasury : details.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) return payload([], [], companyFailureText({ reason: 'amount' }));
    if (amount > company.treasury) return payload([], [], companyFailureText({ reason: 'treasury' }));
    return companyConfirmation(guildId, userId, { action: 'withdraw', amount, version }, { now });
}

export async function quoteCompanyModeration(client, guildId, actorId, targetId, action, name, { now = Date.now() } = {}) {
    const state = await companyModerationState(client, guildId, actorId, targetId);
    if (!state.ok) return payload([], [], companyFailureText(state));
    if (action === 'archive' && !state.company) return payload([], [], companyFailureText({ reason: state.archive ? 'archived' : 'missing' }));
    if (action === 'restore') {
        if (!state.archive) return payload([], [], companyFailureText({ reason: 'not_archived' }));
        const issue = companyNameIssue(name);
        if (issue) return payload([], [], companyFailureText({ reason: issue }));
    }
    return companyConfirmation(guildId, actorId, { action, targetId, version: state.version, ...(action === 'restore' ? { name: name.trim() } : {}) }, { now });
}

export async function companiesPanel(client, guildId, { now = Date.now() } = {}) {
    const board = await companyLeaderboard(client, guildId, { now });
    const lines = (rows, value) => rows.slice(0, 10).map((entry, index) => `${index + 1}. **${safe(publicCompanyName(entry.company.name))}** • <@${entry.userId}> • ${formatCC(value(entry.company))}`).join('\n') || 'لسه مفيش شركات.';
    const cups = Object.entries(board.seasons).sort(([a], [b]) => b.localeCompare(a)).slice(0, 6)
        .map(([month, result]) => `🏆 ${month} • <@${result.userId}> • ملك المطاعم • ${formatCC(result.profit)}`).join('\n') || 'أول كأس بعد انتهاء أول شهر فيه أرباح.';
    return payload([
        ccEmbed('💎 أكبر الشركات', lines(board.value, companyValue)),
        ccEmbed(`📅 أرباح الشركات — ${board.month} UTC`, `${lines(board.monthly, (company) => company.monthlyNet[board.month] || 0)}\n\nالموسم بيصفّر الترتيب بس، مش الشركات. الكأس واللقب دائمان في لوحة الشركات؛ مفيش جايزة CC. التعادل لأصغر ID.`),
        ccEmbed('🏆 أبطال المطاعم', cups),
    ]);
}
