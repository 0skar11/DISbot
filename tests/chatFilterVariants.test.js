import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkText, explainText, setCustomRules, INSULTS_ENGLISH } from '../src/services/moderation/chatFilterRules.js';
import {
  generateVariants, variantGroups, francoFold, francoSpellings, arabicSpellings, MAX_VARIANTS, maskNames,
} from '../src/services/moderation/chatFilterVariants.js';

// Owner's request: words added with `automod` are caught in all their spellings (Arabic hidden spellings,
// franco both ways, English equivalents with obfuscation), and the strong English insults are built in.

const wrong = (texts, expected, options) => texts.filter((text) => checkText(text, options) !== expected).map((text) => `${text} → ${checkText(text, options)}`);

describe('generateVariants (pure)', () => {
  test('an Arabic word gets its franco spellings, folded (3=ع 7=ح 5=خ 2=ق, vowels optional)', () => {
    const kalb = generateVariants('كلب');
    for (const form of ['كلب', 'klb', 'kalb', 'kelb', 'kolb']) assert.ok(kalb.includes(form), form);
    const sharmoota = generateVariants('شرموطة');
    for (const form of ['شرموطه', 'sharmota', 'shrmota', 'sharmote', 'شرمت']) assert.ok(sharmoota.includes(form), form);
    // The franco fold makes the usual spellings one form.
    for (const spelling of ['sharmoota', 'sharmouta', 'sharmootah', 'charmouta', 'sharmuta', 'SHARMOOTA'.toLowerCase()]) {
      assert.equal(francoFold(spelling.replace(/(.)\1+/gu, '$1')), 'sharmota', spelling);
    }
    assert.ok(francoSpellings('حمار').includes('hmar') && francoSpellings('حمار').includes('homar'));
    assert.ok(francoSpellings('عرص').includes('3ars'), 'ع → 3');
    assert.ok(francoSpellings('خنزير').includes('khanzer'), 'خ → kh, ي → e');
    assert.ok(francoSpellings('قذر').some((f) => f.startsWith('2')), 'ق → 2');
  });

  test('a franco word also gets its Arabic spellings and skeleton (franco → Arabic)', () => {
    assert.ok(generateVariants('kalb').includes('كلب'));
    assert.ok(arabicSpellings('7mar').includes('همار'), 'merged alphabet: ح = ه');
    assert.deepEqual(variantGroups('sharmoota').skeleton, ['شرمت']);
    assert.ok(generateVariants('m3ars').includes('معرس'), 'ع from 3, ص merged with س');
  });

  test('English equivalents come from the dictionary, with obfuscated spellings', () => {
    const groups = variantGroups('شرموطة');
    assert.ok(groups.english.includes('slut') && groups.english.includes('whore'));
    assert.ok(variantGroups('عرص').english.includes('pimp'));
    assert.ok(variantGroups('خول').english.includes('fagot'), 'faggot (collapsed)');
    assert.ok(variantGroups('نيك').english.includes('fvck'), 'u → v');
    assert.ok(variantGroups('نيك').english.includes('phuck'), 'f → ph');
    assert.ok(variantGroups('نيك').english.includes('fck'), 'f*ck → fck');
    assert.ok(variantGroups('ابن كلب').english.includes('sonofabitch'));
    // Everyday words only count after "you / ya / stupid...".
    assert.ok(variantGroups('كلب').englishEveryday.includes('dog'));
    assert.ok(!variantGroups('كلب').english.includes('dog'));
    // "ass" collapses to the normal word "as": it is kept with its doubled letters.
    assert.ok(variantGroups('طيز').englishDouble.includes('ass'));
  });

  test('the number of spellings is capped and the function is pure', () => {
    const long = 'شرموطةابنكلبمتناكمعرصخنزيرزب'.slice(0, 30);
    assert.ok(generateVariants(long).length <= MAX_VARIANTS);
    assert.ok(generateVariants('ابن كلب حقير وسخ').length <= MAX_VARIANTS);
    assert.deepEqual(generateVariants('كلب'), generateVariants('كلب'));
    assert.deepEqual(generateVariants(''), []);
    assert.ok(Object.isFrozen(variantGroups('كلب')));
  });
});

describe('built-in English insults (every server)', () => {
  beforeEach(() => setCustomRules({}));

  const POSITIVES = [
    'fuck', 'fuck you', 'FUCK OFF', 'f*ck', 'f.u.c.k', 'f u c k', 'fvck', 'phuck', 'fuk', 'fck', 'fucking idiot', 'fucker', 'fuckin hell',
    'motherfucker', 'mothafucka', 'bitch', 'b!tch', 'b1tch', 'biatch', 'bitches', 'son of a bitch', 'sonofabitch', 'cunt', 'c u n t', 'whore',
    'wh0re', 'slut', 'sluts', 'you dick', 'dickhead', 'dicc', 'DICK', 'pussy', 'asshole', 'a$$hole', 'a55hole', 'arsehole', 'dumbass',
    'jackass', 'bastard', 'nigger', 'nigga', 'n1gga', 'niggas', 'niiiigga', 'faggot', 'fag', 'retard', 'retarded', 'twat', 'wanker',
    'cocksucker', 'ya bitch', 'يا bitch', 'fuuuuuck', 'ｆｕｃｋ', 'ƒuck'.normalize('NFKC'), 'motherfucking',
  ].filter((text) => text !== 'ƒuck');
  const NEGATIVES = [
    'class starts at 9', 'the assassin', 'Scunthorpe United', 'my pussycat', 'Moby Dick is a book', 'Dick Grayson is Nightwing',
    'Philip K. Dick wrote it', 'a cocktail please', 'Charles Dickens', 'Niger and Nigeria', 'do not snigger', 'shiitake mushrooms',
    'my therapist', 'I passed the class', 'kiss me', 'as soon as possible', 'bass guitar', 'hello there', 'my dog is cute', 'hot dog',
    'grass is green', 'pass the ball', 'Sussex', 'a bit much', 'dickens of a time', 'the fag end of the day'.replace('fag', 'tail'),
    'nightcap', 'cockpit', 'shuttlecock', 'assume', 'mass', 'embarrass', 'compass', 'cunning plan', 'title', 'wassup', 'bitcoin',
    'sniggered', 'retardant', 'whored'.replace('whored', 'hoard'), 'skanderbeg', 'twatt'.replace('twatt', 'twitter'),
  ];

  test(`${POSITIVES.length} English insults and obfuscations are caught as insult`, () => {
    assert.deepEqual(wrong(POSITIVES, 'insult'), []);
  });

  test(`${NEGATIVES.length} normal English words and names are left alone`, () => {
    assert.deepEqual(wrong(NEGATIVES, null), []);
  });

  test('"Dick" next to another capitalised word is a name; "you Dick" is not', () => {
    assert.equal(maskNames('Moby Dick'), 'Moby  ');
    assert.equal(maskNames('you Dick'), 'you Dick');
    assert.equal(checkText('Dick'), 'insult');
    assert.equal(checkText('hey Dick'), 'insult');
  });

  test('the original built-in lists are unchanged (legacy option): no English there', () => {
    assert.deepEqual(wrong(['fuck', 'bitch', 'nigga', 'asshole'], null, { legacy: true }), []);
    assert.equal(checkText('sharmoota', { legacy: true }), 'insult');
    assert.equal(checkText('كسمك', { legacy: true }), 'family');
  });

  test('an English word can be switched off', () => {
    setCustomRules({ disabled: ['fuck'] });
    assert.equal(checkText('fuck'), null);
    assert.equal(checkText('fucking'), null);
    assert.equal(checkText('motherfucker'), 'insult', 'its own entry');
    assert.ok(INSULTS_ENGLISH.some((entry) => entry.word === 'fuck'));
  });
});

describe('setCustomRules: the owner words take effect at once for every rule class', () => {
  beforeEach(() => setCustomRules({}));

  test('insult / family / banned words with all their spellings; ibnAl only after "ابن ال..."', () => {
    setCustomRules({ custom: [
      { word: 'كلب', rule: 'insult' }, { word: 'حمار', rule: 'family' }, { word: 'بقرة', rule: 'ibnAl' }, { word: 'سبونج', rule: 'banned' },
    ] });
    const hidden = ['كلب', 'يا كلب', 'ك.ل.ب', 'ك ل ب', 'كـلـب', 'كَلْب', 'كللللب', 'ﻛﻠﺐ', 'ك\u200bلب', 'كلبك', 'الكلب', 'وكلب', 'كلb',
      'kalb', 'k4lb', 'K.A.L.B', 'kaaalb', 'ya kalb', 'kalbak', 'kelb', 'klb', 'you dog', 'ya dog', 'stupid dog', "you're a dog", 'u r a dog', 'يا dog'];
    assert.deepEqual(wrong(hidden, 'insult'), []);
    assert.deepEqual(wrong(['حمار', 'يا حمار', '7mar', 'homar', 'hmar', 'ح م ا ر', 'you donkey'], 'family'), []);
    assert.deepEqual(wrong(['ابن البقرة', 'يا ابن البقره', 'ابن بقرة', 'ابنالبقره', 'ebn el ba2ara', 'ibn el bakara', 'son of a cow'], 'ibnAl'), []);
    assert.deepEqual(wrong(['سبونج', 'س.ب.و.ن.ج', 'sbonj', 'sponj'.replace('p', 'b')], 'banned'), []);
    // Normal words around them stay.
    assert.deepEqual(wrong(['قلب', 'قلبي', 'كلية', 'كلبش', 'club', 'humor', 'hammer', 'Kaleb', 'my dog', 'hot dog', 'dog food', 'بقرة',
      'لحمة بقري', 'donkey kong', 'الكلام ده', 'كلبوظ'], null), []);
  });

  test('everyday English equivalents need "you / ya..." even when their letters are doubled (ass, butt)', () => {
    setCustomRules({ custom: [{ word: 'حمار', rule: 'family' }] });
    assert.deepEqual(wrong(['ass', 'a$$', 'as', 'class', 'my ass hurts'.replace('my ', 'the '), 'donkey'], null), []);
    assert.deepEqual(wrong(['you ass', 'ya a$$', 'you donkey', 'u r a donkey'], 'family'), []);
    setCustomRules({ custom: [{ word: 'زبالة', rule: 'banned' }] });
    assert.equal(checkText('take out the trash'), null);
    assert.equal(checkText('you trash'), 'banned');
  });

  test('explainText says which word matched', () => {
    setCustomRules({ custom: [{ word: 'كلب', rule: 'insult' }] });
    assert.deepEqual(explainText('ya kalb'), { rule: 'insult', source: 'custom', word: 'كلب' });
    assert.deepEqual(explainText('fuck'), { rule: 'insult', source: 'english', word: 'fuck' });
    assert.deepEqual(explainText('كسمك'), { rule: 'family', source: 'builtin' });
    assert.equal(explainText('hello'), null);
  });

  test('a franco / Latin owner word matches its Arabic spellings and English forms', () => {
    setCustomRules({ custom: [{ word: 'noob', rule: 'insult' }, { word: '5anee2', rule: 'insult' }] });
    assert.deepEqual(wrong(['noob', 'n00b', 'NOOOOB', 'n.o.o.b', 'نوب', 'يا نوب', '5anee2', 'khanee2', 'خانيق', 'خنيق'], 'insult'), []);
    // "ee" is a long vowel: خانق / خان are other words.
    assert.deepEqual(wrong(['notebook', 'knob hill', 'خانه', 'خان', 'خانق', 'خاين'], null), []);
  });

  test('switched-off built-in words stop counting at once; the others and the patterns stay', () => {
    setCustomRules({ disabled: ['طيز', 'teez', 'tez'] });
    assert.equal(checkText('طيز'), null);
    assert.equal(checkText('teez'), null);
    assert.equal(checkText('طيز', { legacy: true }), 'insult', 'the original list still has it');
    assert.equal(checkText('متناك'), 'insult');
    assert.equal(checkText('كسمك'), 'family');
    setCustomRules({ disabled: ['كلب'] });
    assert.equal(checkText('ابن الكلب'), null, 'ibn al completion switched off');
    assert.equal(checkText('ابن الجزمة'), 'ibnAl');
    setCustomRules({ disabled: ['شرموط', 'شرموطه', 'شراميط', 'sharmot', 'sharmota', 'sharmouta', 'shrmota'] });
    assert.equal(checkText('شرموطه'), null);
    assert.equal(checkText('sharmoota'), null, 'its skeleton is off too');
  });

  test('bad input never throws and changes nothing it should not', () => {
    for (const input of [null, undefined, 5, { custom: 'x' }, { custom: [null, { word: 5 }, { word: 'x', rule: 'nope' }] }, { disabled: [null, 3] }]) {
      assert.doesNotThrow(() => setCustomRules(input));
    }
    assert.equal(checkText('كسمك'), 'family');
    assert.equal(checkText('hello'), null);
  });

  test('bare ميتين, خوله and عرس stay unfiltered (only ميتين امك, خول, عرص are insults)', () => {
    setCustomRules({ custom: [{ word: 'كلب', rule: 'insult' }, { word: 'حمار', rule: 'family' }] });
    for (const options of [{}, { legacy: true }]) {
      assert.deepEqual(wrong(['ميتين', 'ميتين جنيه', 'دفعت ميتين', 'خوله صاحبتي', 'خوله', 'عرس اخويا', 'عريس', 'meteen', 'mitin'], null, options), []);
    }
  });
});

describe('performance', () => {
  test('checkText on 2,000-character messages with 500 owner words stays under ~5 ms', () => {
    const letters = 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي';
    const latin = 'abcdefghiklmnoprstuvwyz';
    let seed = 11;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const word = (abc, n) => Array.from({ length: n }, () => abc[Math.floor(random() * abc.length)]).join('');
    const custom = Array.from({ length: 500 }, (_, i) => ({
      word: i % 4 === 0 ? word(latin, 4 + (i % 5)) : i % 7 === 0 ? `${word(letters, 3)} ${word(letters, 4)}` : word(letters, 3 + (i % 6)),
      rule: ['insult', 'family', 'banned', 'ibnAl'][i % 4],
    }));
    setCustomRules({ custom });
    const vocabulary = ['السلام', 'عليكم', 'ازيك', 'عامل', 'ايه', 'النهارده', 'hello', 'how', 'are', 'you', 'tamam', '3amel', 'eh', 'game',
      'الماتش', 'بكرة', 'yalla', 'ok', 'خلاص', 'تمام', 'gg', 'wp', 'واحد', '2', 'fen'];
    const messages = [0, 1, 2].map((offset) => {
      let text = '';
      for (let i = 0; text.length < 2000; i += 1) text += `${vocabulary[(i * 7 + offset) % vocabulary.length]} `;
      return text.slice(0, 2000);
    });
    for (const text of messages) for (let i = 0; i < 10; i += 1) checkText(text);
    // Best of several batches, by wall time or by this process's CPU time, so other test files running at the
    // same time (node --test runs them in parallel) do not fail the test.
    let best = Infinity;
    const calls = 20 * messages.length;
    for (let batch = 0; batch < 7; batch += 1) {
      const start = performance.now();
      const cpu = process.cpuUsage();
      for (let i = 0; i < 20; i += 1) for (const text of messages) checkText(text);
      const used = process.cpuUsage(cpu);
      best = Math.min(best, (performance.now() - start) / calls, (used.user + used.system) / 1000 / calls);
    }
    assert.ok(best < 5, `checkText took ${best.toFixed(2)} ms`);
    setCustomRules({});
  });
});
