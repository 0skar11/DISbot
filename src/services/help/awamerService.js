// awamerService.js — Interactive GUI for bot commands (GH-306)
// Provides a categorized, visual Arabic command guide for both staff and regular members.

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export const AWAMER_CATEGORIES = {
  admin: {
    id: 'admin',
    label: 'أوامر الإدارة والإشراف',
    description: 'العقوبات، سحب الفويس، إدارة الرومات، الرتب، والتراست',
    emoji: '🛡️',
    color: 0xe74c3c,
    fields: [
      {
        name: '🔊 التحكم بالفويس',
        value: [
          '• `.سحب @العضو` — سحب العضو لرومك الصوتي من أي روم حتى لو مقفول (GH-304).',
        ].join('\n'),
      },
      {
        name: '⚖️ العقوبات والإشراف',
        value: [
          '• `.بان @العضو [السبب]` — حظر عضو من السيرفر.',
          '• `.انبان <ID>` — فك الحظر عن عضو بالـ ID.',
          '• `.كيك @العضو [السبب]` — طرد عضو من السيرفر.',
          '• `.تايم @العضو [المدة] [السبب]` — تايم أوت (مثال: `10m`, `1h`, `1d`).',
          '• `.انتايم @العضو` — فك التايم أوت عن العضو فوراً.',
          '• `.وارن @العضو [السبب]` — إعطاء تحذير رسمي للعضو.',
          '• `.وارنات @العضو` — عرض سجل تحذيرات العضو.',
          '• `.مسح تحذيرات @العضو` — مسح جميع تحذيرات العضو.',
        ].join('\n'),
      },
      {
        name: '💬 إدارة الشات والرومات',
        value: [
          '• `.كلير [العدد]` / `.مسح [العدد]` / `.م [العدد]` — مسح رسائل من الروم (1 إلى 100).',
          '• `.قفل` / `.ق` — قفل الكتابة في الروم الحالي.',
          '• `.فتح` / `.ف` — فتح الكتابة في الروم الحالي.',
        ].join('\n'),
      },
      {
        name: '🏷️ إدارة الرتب والأسماء',
        value: [
          '• `.رول @العضو <الرتبة>` / `.ر @العضو <الرتبة>` — إعطاء رتبة لعضو.',
          '• `.شيل @العضو <الرتبة>` / `.ب @العضو <الرتبة>` — إزالة رتبة من عضو.',
          '• `.نك @العضو [الاسم الجديد]` — تغيير اسم العضو في السيرفر.',
        ].join('\n'),
      },
      {
        name: '🛡️ الحماية (Anti-Nuke)',
        value: [
          '• `.تراست @العضو` — إضافة عضو لقائمة الموثوقين المسموح لهم بالأفعال الإدارية.',
          '• `.انتراست @العضو` — إزالة عضو من قائمة الموثوقين.',
          '• `.خطر @العضو` — إضافة عضو لقائمة الخطر للمراقبة الصارمة.',
          '• `!trusted` — عرض قائمة الموثوقين الحاليين.',
        ].join('\n'),
      },
    ],
  },
  general: {
    id: 'general',
    label: 'أوامر الأعضاء والأدوات',
    description: 'كابشن الميمز، إزالة الخلفية، الجيف، والبروفايل',
    emoji: '👤',
    color: 0x3498db,
    fields: [
      {
        name: '🖼️ الصور والميمز',
        value: [
          '• `.caption <النص>` / `.كابشن <النص>` — كتابة نص ميمز بخلفية بيضاء فوق أي صورة أو GIF.',
          '• `.شيل الخلفية` / `.removebg` — إزالة خلفية الصورة بتقنية الذكاء الاصطناعي.',
          '• `.gif` / `.جيف` — تحويل أي صورة ثابتة إلى ملف GIF.',
        ].join('\n'),
      },
      {
        name: '👤 الحساب والمعلومات',
        value: [
          '• `.افاتار [@العضو]` / `.avatar` — عرض صورة الحساب الشخصية بأعلى جودة.',
          '• `.يوزر [@العضو]` / `/userinfo` — معلومات العضو وتاريخ انضمامه ورتبه.',
          '• `.سيرفر` / `/serverinfo` — إحصائيات ومعلومات السيرفر الحالية.',
        ].join('\n'),
      },
      {
        name: '⚙️ الخدمات والتفاعل',
        value: [
          '• `.afk [السبب]` — تفعيل وضع الغياب، وعند منشنتك البوت يخبر منشنك بسبب غيابك.',
          '• `.بنق` / `/ping` — فحص سرعة استجابة واتصال البوت.',
        ].join('\n'),
      },
    ],
  },
  tickets: {
    id: 'tickets',
    label: 'نظام التكتات والتوثيق',
    description: 'فتح تكتات الدعم الفني وتوثيق البنات',
    emoji: '🎫',
    color: 0xe91e63,
    fields: [
      {
        name: '📩 فتح التكت',
        value: [
          '• يتم فتح التكت من روم `📩・افتح-تكت` بالضغط على الزر المناسب:',
          '  - `🛠️ مشكلة` — لتقديم شكوى أو استفسار للإدارة.',
          '  - `🎀 توثيق بنات` — تكت خاص بالبنات فقط للتوثيق.',
        ].join('\n'),
      },
      {
        name: '🔘 الأزرار داخل التكت',
        value: [
          '• `🙋 استلام` — استلام التكت من قبل الإداري المسؤول.',
          '• `🔒 قفل` — إغلاق التكت وحفظ سجل المحادثة (الترانسكريبت) في روم `📁・سجل-التكتات`.',
          '• `✅ توثيق` — منح رول التوثيق فوراً (في تكتات التوثيق فقط).',
        ].join('\n'),
      },
    ],
  },
  leveling: {
    id: 'leveling',
    label: 'نظام المستوى والرانك',
    description: 'نقاط الخبرة XP، الرانك، وقوائم التوب',
    emoji: '📊',
    color: 0xf1c40f,
    fields: [
      {
        name: '📈 الرانك والمتصدرين',
        value: [
          '• `.لفل` / `/rank` — عرض بطاقة مستواك الحالي ونقاط الخبرة والرانك.',
          '• `.توب` / `/leaderboard` — عرض قائمة متصدري السيرفر في التفاعل واللفل.',
        ].join('\n'),
      },
    ],
  },
};

export function buildAwamerSelectMenu(selectedId = null) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('awamer_select')
    .setPlaceholder('🔍 اختار قسم الأوامر لعرضه...');

  for (const cat of Object.values(AWAMER_CATEGORIES)) {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(cat.label)
      .setDescription(cat.description)
      .setValue(cat.id)
      .setEmoji(cat.emoji);
    if (selectedId === cat.id) {
      option.setDefault(true);
    }
    select.addOptions(option);
  }

  return new ActionRowBuilder().addComponents(select);
}

export function buildAwamerHomeButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('awamer_home')
      .setLabel('🏠 القائمة الرئيسية')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildAwamerMainPayload(client) {
  const botName = client?.user?.displayName || client?.user?.username || 'Aether';
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📜 لوحة أوامر البوت — ${botName}`)
    .setDescription([
      'أهلاً بك في **دليل أوامر البوت** التفاعلي! 🤖✨',
      '',
      '📌 **طريقة الاستخدام:**',
      'اختر القسم الذي تريده من القائمة المنسدلة بالأسفل لاستعراض الأوامر الخاصة به مع الشرح الكامل وطريقة الكتابة.',
      '',
      '📁 **الأقسام المتاحة:**',
      '• 🛡️ **أوامر الإدارة والإشراف** — العقوبات، سحب الفويس، إدارة الرومات والرتب، وحماية التراست.',
      '• 👤 **أوامر الأعضاء والأدوات** — كابشن الميمز، إزالة الخلفية، الجيف، البروفايل والأفاتار.',
      '• 🎫 **نظام التكتات والتوثيق** — تكتات المشاكل وتوثيق البنات.',
      '• 📊 **نظام المستوى والرانك** — بطاقة اللفل وقائمة التوب.',
    ].join('\n'))
    .setThumbnail(client?.user?.displayAvatarURL?.({ size: 512 }) || null)
    .setFooter({ text: 'Aether Bot • دليل الأوامر الشامل' })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [buildAwamerSelectMenu()],
  };
}

export function buildAwamerCategoryPayload(client, categoryId) {
  const cat = AWAMER_CATEGORIES[categoryId];
  if (!cat) return buildAwamerMainPayload(client);

  const embed = new EmbedBuilder()
    .setColor(cat.color)
    .setTitle(`${cat.emoji} ${cat.label}`)
    .setDescription(`${cat.description}\n${'─'.repeat(30)}`)
    .setFooter({ text: 'Aether Bot • استخدم القائمة للتنقل بين الأقسام' })
    .setTimestamp();

  for (const field of cat.fields) {
    embed.addFields(field);
  }

  return {
    embeds: [embed],
    components: [buildAwamerSelectMenu(cat.id), buildAwamerHomeButton()],
  };
}
