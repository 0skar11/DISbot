import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from '../src/services/moderation/chatFilterRules.js';

// Owner's rules for the insult filter: family insults (كسمك, زانية, دين امك, ميتين امك...) → 'family';
// only real insults after "ابن ال..." → 'ibnAl'; the other insults → 'insult' exactly as before.
// Every spelling below must be caught: Arabic, franco/Arabizi and hidden (dots, spaces, symbols,
// tashkeel/tatweel/zero-width, repeats, mixed scripts, look-alike letters and leetspeak).
const POSITIVES = {
  family: [
    // Arabic
    'كسمك', 'كس امك', 'كسامك', 'كسومك', 'كسم', 'يا كسمك', 'كسمها', 'كسمكم', 'كس اختك', 'كس ابوك', 'كس اهلك', 'كس دين امك',
    'زانيه', 'يا زانية', 'الزانيه', 'امك زانيه', 'دين امك', 'دين ابوك', 'يلعن دين امك', 'يلعن دينك', 'يلعن ابوك', 'يلعن ابو امك',
    'يلعن سلسفيل اهلك', 'ميتين امك', 'ميتين ام', 'ميتين ابو', 'ميتين ابوك', 'ميتين دين', 'ميتين دينك', 'ميتين اهل', 'ميتين اهلك',
    'يا ميتين امك', 'روح يلعن ميتين اهلك',
    // hidden Arabic
    'ك.س.م.ك', 'ك س م ك', 'كـسـمـك', 'كَسَمَك', 'كسسسسمك', 'ك​سمك', 'ﻛﺴﻤﻚ', 'ز.ا.ن.ي.ه', 'زانـيـه', 'ميـتـين امـك',
    'ي.ل.ع.ن د.ي.ن.ك', 'كسmك', 'ك$مك', 'ks امك', 'x امك', 'كـــس امـــك', 'ك/س/م/ك', 'ك-س-م-ك',
    // franco and hidden franco
    'ksomak', 'kosomk', 'ks omak', 'kosomak', 'kos omak', 'ksmk', 'k$mk', 'k*s*m*k', 'k.o.s.o.m.a.k', 'KOSOMAK', 'k0s0mak',
    'kosom', 'kos okhtak', 'kos o5tak', 'kos abook', 'x omak', 'zanya', 'zaneya', 'zania', 'el zanya', 'meteen omak',
    'mitin abook', 'yel3an deenak', 'yl3n omak', 'deen omak', 'kooosoooomak', 'kusumak', 'ya kosomak',
    // look-alike letters
    'Кosomak', 'κοσομακ', 'ｋｏｓｏｍａｋ', '𝐤𝐨𝐬𝐨𝐦𝐚𝐤', 'kоsоmаk',
  ],
  ibnAl: [
    'ابن الجزمة', 'ابن الجزمه', 'يا ابن الجزمه', 'يابن الجزمه', 'ابن الكلب', 'ابن كلب', 'يا ابن الكلب', 'ابن الكلبه', 'ابن الكلاب',
    'ابن الحمار', 'ابن الوسخه', 'ابن الوسخ', 'ابن المتناكه', 'ابن الشرموطه', 'ابن القحبه', 'ابن الزانيه', 'ابن الحرام',
    'ابن الزبالة', 'ابن الخنزير', 'بنت الكلب', 'إبن الكلب', 'يا بن الكلب',
    'ا.ب.ن ا.ل.ك.ل.ب', 'ابن الك لب', 'ابنالكلب', 'ابن الكــلب', 'ابن الجـزمـة', 'اِبْنُ الكَلْب', 'ابن الككككلب',
    'ebn el gazma', 'ibn el kalb', 'ebn el 7mar', 'ebn el 7omar', 'ebn el kalb', 'ya ebn el gazma', 'yabn el kalb', 'ebn kalb',
    'ibn el wes5a', 'ebn el metnaka', 'ebn el sharmoota', 'ebn el a7ba', 'ebn el zanya', 'ebn el 7aram', 'ebn el zbala',
    'bint el kalb', 'ebn el g@zma', 'ebn الكلب', 'ebnelkalb', 'EBN EL GAZMA', 'e.b.n e.l k.a.l.b', 'ebn el gazmaaa',
  ],
  insult: [
    'يا شرموط', 'متناك', 'انت خول', 'يا عرص', 'معرص', 'طيزك', 'يا منيوك', 'شرموطه', 'شر موطه', 'ش.ر.م.و.ط', 'شرmوط',
    'متن اكه', 'خووول', 'عرصه', 'عرصة', 'خ.و.ل', 'امك شرموطه', 'يا ديوث', 'قحبه', 'لبوه', 'ش ر م و ط ه', 'خ ـو ل',
    'ya khawal', 'khawal', '5awal', 'sharmota', 'sharmoota', 'sharmouta', 'sh4rm0ta', 'metnak', 'mitnak', 'manyok', '3ars',
    'a3ars', 'm3ars', 'zobr', 'a7ba', 'dayouth', 'shar mota', 'kha wal', 's.h.a.r.m.o.t.a', 'ѕharmota', 'ｓｈａｒｍｏｔａ', 'metnaka',
  ],
};

const NEGATIVES = [
  'كسرت الكوباية', 'كسبت الماتش', 'كسوف الشمس النهارده', 'انت كسول اوي', 'ابن عمي جه', 'ابن الحلال', 'ابن الناس الطيبين',
  'ابن البلد', 'ابن الاصول', 'ابن الجيران', 'ابن الكلية', 'ابن العم', 'ابن خالتي', 'ابن الحته', 'ابن مصر', 'عدد الاعضاء كبير',
  'الحفرة', 'الحفره في الشارع', 'كوسا محشي', 'كوسا مسلوقه', 'كوسا مكرونه', 'Koosa', 'Kasem', 'kasem is here', 'قاسم', 'kiss me',
  'class starts at 9', 'wear a mask', 'ebn', 'ibn Sina', 'Ibn Battuta', 'Ibn Khaldun', 'ebn el nas', 'ebn el 7alal', 'ebn 3ami',
  'ebn el balad', 'https://youtube.com/watch?v=ksmk123', 'https://discord.gg/kosomak', '@kasem_99', 'ميتين جنيه', 'دفعت ميتين',
  'عندي ميتين صاحب', 'امك عامله ايه', 'سلملي على امك', 'ابوك فين', 'يلعن ابو الزحمة', 'يلعن ابو كده', 'دين الاسلام',
  'الدين امانة', 'مكسيكو', 'بوكس', 'زبادي', 'زبون', 'زبيب', 'نيكون', 'نيكول', 'Nick', 'خوله صاحبتي', 'دخول', 'عرس اخويا',
  'عريس', '3aris', '3arosa', 'sharm el sheikh', 'kosmos', 'cosmic', 'zebra', 'sawal', 'menak', 'khali', 'khal', 'zein', 'Zana',
  'zanaty', 'عندك سمك', 'بتاعك سمكه', 'لك سمك', 'كاس العالم', 'كيس', 'قسمك', 'متن الكتاب', 'متناول', 'شرم الشيخ', 'abook', 'omak',
  'deen', 'deenak', 'دينك ايه', 'yalla', 'lol xD', 'KSA', 'bin laden', 'been there', 'the bin is full', 'احا', 'طز فيك',
  'kiss my cat', 'mask off', 'كسرة خبز', 'الكسب الحلال', 'كسوة العيد', 'ابن ستة', 'Ibn Rushd', 'ibn el 3am', 'كسا', 'كوسه',
];

describe('chat filter corpus (owner rules: family / ibn al blacklist / hidden spellings)', () => {
  for (const [rule, texts] of Object.entries(POSITIVES)) {
    test(`${texts.length} ${rule} spellings are caught`, () => {
      const wrong = texts.filter((text) => checkText(text) !== rule).map((text) => `${text} → ${checkText(text)}`);
      assert.deepEqual(wrong, []);
    });
  }

  test(`${NEGATIVES.length} normal sentences are left alone`, () => {
    const wrong = NEGATIVES.filter((text) => checkText(text) !== null).map((text) => `${text} → ${checkText(text)}`);
    assert.deepEqual(wrong, []);
  });

  test('links: an insult in the host or around the link is caught; random ids in the path are not', () => {
    const caught = {
      'https://ksomak': 'family', 'http://kosomak.com': 'family', 'www.kosomak.com': 'family', 'شوف www.kosomak.com/x': 'family',
      'discord.gg/ibn el gazma': 'ibnAl', 'https://ebn-el-gazma.com': 'ibnAl', 'https://example.com/كسمك': 'family',
      'https://youtu.be/abc يا شرموط': 'insult', 'https://sharmota.net/watch?v=1': 'insult',
    };
    for (const [text, rule] of Object.entries(caught)) assert.equal(checkText(text), rule, text);
    for (const text of ['https://youtube.com/watch?v=ksmk123', 'https://discord.gg/kosomak', 'discord.gg/ksmk', 'discord.com/invite/sharmota',
      'www.google.com/search?q=kasem', 'https://cdn.discordapp.com/attachments/1/2/kosomak.png', 'شوف ده https://x.com/u/ebn_el_kalb',
      'https://github.com/kasem/repo', 'http://localhost:3000/ksmk']) {
      assert.equal(checkText(text), null, text);
    }
  });

  test('corpus size meets the quality bar', () => {
    assert.ok(NEGATIVES.length >= 60);
    assert.ok(Object.values(POSITIVES).flat().length >= 120);
  });
});
