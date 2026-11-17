// guideUi.js — `شرح`: a short guide to CC, the store and the bourse, sent to the member in DM
// (src/commands/Games/guide.js). Every number comes from the config, so the guide never goes stale.
// Plain embed objects so the emojis stay.
//
// Report #283 ("خفف الشرح شويه ك محتويات وخليه منظم"): the guide opens on a short contents page with a
// menu, and each section is its own short page (src/interactions/selectMenus/guide/guideSection.js).

import { inviteConditions } from '../inviteRewardService.js';
import { CC, ccEmbed, ccBoostLine, gamesBotReward } from '../../config/cc.js';
import { bourseSettings } from '../../config/store/bourse.js';
import { INVITE_REWARDS } from '../../config/inviteRewards.js';
import { GAMES_BOTS_CHANNEL_ID } from '../../config/games.js';
import { isHomeGuild } from '../../config/homeGuild.js';
import { isStreakEnabled, STREAK } from './streakService.js';
import { COMPANY } from '../../config/store/companies.js';

export const GUIDE_MENU_PREFIX = 'guide';
export const GUIDE_CONTENTS = 'contents';

const n = (value) => Number(value || 0).toLocaleString('en-US');

// `guildId`: our server's guide also explains the custom roles (`رولي`), the shortcuts and the companies, sold there only.
export function buildGuideSections({ boostLine = ccBoostLine(), guildId = null } = {}) {
    const { demand } = bourseSettings;
    const { transfer, levelUp } = CC;
    const home = isHomeGuild(guildId);
    return [
        { id: 'cc', emoji: '💰', label: `يعني إيه ${CC.short}`, embed: ccEmbed(`💰 يعني إيه ${CC.short}`, [
            `**${CC.short}** هي فلوس السيرفر: بتجمعها وتصرفها في المتجر أو تستثمرها في البورصة.`,
            '💰 زرار **رصيدي** و🏆 زرار **توب CC** في لوحة المتجر ← رصيدك وترتيب السيرفر',
            ...(boostLine ? [boostLine] : []),
        ].join('\n')) },
        { id: 'earn', emoji: '💡', label: 'تكسب CC ازاي', embed: ccEmbed('💡 تكسب CC ازاي', [
            `🎮 **الألعاب** في <#${GAMES_BOTS_CHANNEL_ID}>: الفوز **${n(gamesBotReward('group', guildId))}**، وأول إجابة **${n(gamesBotReward('answer', guildId))}**`,
            `⭐ **اللفل**: رقم اللفل × ${n(levelUp.perLevel)} (لفل 10 = ${n(levelUp.perLevel * 10)})`,
            `📨 **الدعوات**: **${n(INVITE_REWARDS.reward)}** لكل حد تدعوه و${inviteConditions()}`,
            ...(home && isStreakEnabled() ? [`🔥 **الستريك**: صورة أو GIF كل يوم في روم الستريك = **${n(STREAK.base)}** في اليوم، وبتزيد لحد **${n(STREAK.cap)}** (\`ستريك\`)`] : []),
        ].join('\n'), { color: 'success' }) },
        { id: 'store', emoji: '🛒', label: 'المتجر', embed: ccEmbed('🛒 المتجر', [
            '🛍️ `متجر` ← المنتجات والأسعار، وتشتري من القايمة',
            '🛒 `متجر 1` أو `متجر اسم المنتج` ← تشتري، و`متجر 1 3` ← 3 قطع',
            '🎒 `مخزني` ← الحاجات اللي اشتريتها',
            ...(home ? [
                '🎨 `رولي` ← رولك المميزة (`رولي انفايت @صاحبك` / `رولي اخرج` / `رولي الغي` / `رولي كمل`)',
                '✅ `متجر 1 3 تأكيد` ← شراء مباشر من غير زرار (الرتب المميزة لازم تختار بياناتها). لو الخاص مقفول، نتيجة الصندوق أو التنبؤ بتظهر ليك بس من زرار في الإيصال لمدة 5 دقايق.',
            ] : ['قبل أي شراء بيجيلك زرار ✅ تأكد بيه.']),
        ].join('\n')) },
        { id: 'bourse', emoji: '📈', label: 'البورصة', embed: ccEmbed('📈 البورصة (الاستثمار)', [
            `حاجات زي العربية والشقة، بتشتريها وتبيعها في <#${GAMES_BOTS_CHANNEL_ID}>، وسعرها **بيتغير كل ساعة** لحد **${bourseSettings.maxMovePercent}%**.`,
            '📊 `اسعار` • 💵 `شراء عربية 2` أو `استثمار عربية` • 💸 `بيع عربية` • 💼 `ممتلكاتي`',
            ...(home ? ['✅ `شراء عربية 2 تأكيد` / `بيع عربية 2 تأكيد` من غير زرار • `كلو` بدل العدد = أكبر عدد أو كل القطع (`بيع كلو` = كل حاجة)'] : []),
            `🔥 لو اتشرى **${demand.guaranteedRiseUnits} قطعة أو أكتر** من حاجة في ساعة، سعرها **لازم يزيد** الساعة الجاية.`,
            `🧾 رسوم البيع **${bourseSettings.sellFeePercent}%**، وأقصاك **${bourseSettings.maxOwnedPerAsset} قطعة** من كل حاجة.`,
            ...(home ? ['🏰 **القصر**: بيبدأ بحوالي 50,000، سعره عشوائي ومالوش سقف، وأقصاك **5**.'] : []),
        ].join('\n'), { color: 'info' }) },
        ...(home ? [{ id: 'company', emoji: '🏢', label: 'شركات المطاعم', embed: ccEmbed('🏢 شركات المطاعم', [
            `🏗️ \`شركة إنشاء اسم الشركة\` ← مطعم بـ **${n(COMPANY.createCost)} CC** بعد التأكيد`,
            '🏦 `شركة` / `شركة خزنة` ← الأرباح والخزنة، والربح بينزل الخزنة كل 24 ساعة',
            '⬆️ `شركة تطوير` ← فروع / جودة / تسويق: أقصى 5 لكل نوع، وتطوير واحد كل 24 ساعة',
            '💵 `شركة سحب 5000` ← أرباحك لرصيدك بعد التأكيد',
            '🏆 `شركات` ← ترتيب القيمة وأرباح الشهر وكأس ملك المطاعم',
        ].join('\n')) }] : []),
        { id: 'transfer', emoji: '🔁', label: 'التحويل', embed: ccEmbed('🔁 التحويل', [
            '`تحويل @صاحبك 100` ← تبعتله 100',
            `أول ${transfer.cheapPerWeek} تحويلات في الأسبوع ضريبتها **${transfer.taxPercent}%**، وبعدها بتزيد لحد ${transfer.maxTaxPercent}%. أقل تحويل ${n(transfer.minAmount)} ${CC.short}.`,
        ].join('\n')) },
    ];
}

/** Every section as an embed (the whole guide in one list). */
export function buildGuideEmbeds(options = {}) {
    return buildGuideSections(options).map((section) => section.embed);
}

function contentsEmbed(sections) {
    return ccEmbed(`${CC.emoji} شرح ${CC.short} — المحتويات`, [
        ...sections.map((section, index) => `**${index + 1}.** ${section.emoji} ${section.label}`),
        '',
        '👇 اختار القسم من القايمة تحت.',
    ].join('\n'));
}

/**
 * The guide message: the contents page (or one section) with the sections menu under it.
 * `guildId` rides in the menu id, since the DM the menu is used in has no server.
 */
export function buildGuidePayload({ guildId = null, section = GUIDE_CONTENTS, boostLine } = {}) {
    const sections = buildGuideSections({ guildId, ...(boostLine === undefined ? {} : { boostLine }) });
    const chosen = sections.find((entry) => entry.id === section);
    return {
        embeds: [chosen ? chosen.embed : contentsEmbed(sections)],
        components: [{ type: 1, components: [{
            type: 3,
            custom_id: `${GUIDE_MENU_PREFIX}:${/^\d{17,20}$/.test(String(guildId)) ? guildId : '0'}`,
            placeholder: '📋 اختار قسم',
            options: [
                { label: 'المحتويات', value: GUIDE_CONTENTS, emoji: { name: '📋' }, default: !chosen },
                ...sections.map((entry) => ({ label: entry.label, value: entry.id, emoji: { name: entry.emoji }, default: entry === chosen })),
            ],
        }] }],
    };
}
