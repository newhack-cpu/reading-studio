'use strict';

const WordLookup = (() => {
  const singleWord = /^[a-z]+$/;
  const irregular = new Map();
  for (const line of `
    be am is are was were been being
    arise arose arisen
    awake awoke awoken
    bear bore born borne
    beat beaten
    become became
    begin began begun
    bend bent
    bind bound
    bite bit bitten
    bleed bled
    blow blew blown
    break broke broken
    breed bred
    bring brought
    build built
    burn burnt
    buy bought
    catch caught
    choose chose chosen
    cling clung
    come came
    creep crept
    deal dealt
    dig dug
    do did done
    draw drew drawn
    dream dreamt
    drink drank drunk
    drive drove driven
    eat ate eaten
    fall fell fallen
    feed fed
    feel felt
    fight fought
    find found
    flee fled
    fly flew flown
    forbid forbade forbidden
    forget forgot forgotten
    forgive forgave forgiven
    freeze froze frozen
    get got gotten
    give gave given
    go went gone
    grow grew grown
    hang hung
    have has had
    hear heard
    hide hid hidden
    hold held
    keep kept
    kneel knelt
    know knew known
    lay laid
    lead led
    lean leant
    leap leapt
    learn learnt
    leave left
    lend lent
    lie lay lain
    light lit
    lose lost
    make made
    mean meant
    meet met
    mistake mistook mistaken
    overcome overcame
    pay paid
    ride rode ridden
    ring rang rung
    rise rose risen
    run ran
    say said
    see saw seen
    seek sought
    sell sold
    send sent
    shake shook shaken
    shine shone
    shoot shot
    show shown
    shrink shrank shrunk
    sing sang sung
    sink sank sunk
    sit sat
    slay slew slain
    sleep slept
    slide slid
    smell smelt
    speak spoke spoken
    speed sped
    spell spelt
    spend spent
    spill spilt
    spin spun
    spit spat
    spoil spoilt
    spring sprang sprung
    stand stood
    steal stole stolen
    stick stuck
    sting stung
    stink stank stunk
    stride strode stridden
    strike struck stricken
    strive strove striven
    swear swore sworn
    sweep swept
    swim swam swum
    swing swung
    take took taken
    teach taught
    tear tore torn
    tell told
    think thought
    throw threw thrown
    tread trod trodden
    undergo underwent undergone
    understand understood
    undertake undertook undertaken
    wake woke woken
    wear wore worn
    weave wove woven
    weep wept
    win won
    withdraw withdrew withdrawn
    withstand withstood
    wring wrung
    write wrote written
    analysis analyses
    axis axes
    basis bases
    calf calves
    child children
    crisis crises
    criterion criteria
    curriculum curricula
    datum data
    die dice
    diagnosis diagnoses
    elf elves
    foot feet
    fungus fungi
    genus genera
    goose geese
    half halves
    hypothesis hypotheses
    index indices
    knife knives
    leaf leaves
    life lives
    loaf loaves
    man men
    matrix matrices
    medium media
    mouse mice
    nucleus nuclei
    oasis oases
    ox oxen
    parenthesis parentheses
    person people
    phenomenon phenomena
    self selves
    shelf shelves
    stimulus stimuli
    syllabus syllabi
    synthesis syntheses
    thesis theses
    tooth teeth
    vertebra vertebrae
    wife wives
    wolf wolves
    woman women
    bad worse worst
    far farther further farthest furthest
    good better best
    well better best
    little less least
    many more most
    much more most
    due duly
    eye eying
    public publicly
    true truly
    whole wholly
  `.trim().split(/\n\s*/)) {
    const [headword, ...forms] = line.split(' ');
    for (const form of forms) {
      if (!irregular.has(form)) irregular.set(form, []);
      irregular.get(form).push(headword);
    }
  }

  const finiteVerb = /^(?:v|vt|vi|aux)$/;
  const presentOrPlural = /^(?:v|vt|vi|aux|n)$/;
  const comparative = /^(?:adj|adv)$/;
  const adjective = /^adj$/;
  const partOfSpeech = /^(?:v|vt|vi|aux|n|adj|adv|prep|conj|pron|num|art|int|interj|det)$/;
  const sibilant = /(?:[sxz]|[cs]h)$/;
  const doubleConsonant = /[aeiou]([bdfgklmnprstz])\1$/;

  function supports(word, part, splitGloss) {
    const glosses = [...(word.glosses || []), ...(word.cetGlosses || []), ...(word.cet4Glosses || []), ...(word.personal?.gloss?.split('\n') || [])];
    const parts = glosses.flatMap(gloss => splitGloss(gloss).pos.toLowerCase().match(/[a-z]+/g) || [])
      .filter(tag => partOfSpeech.test(tag));
    return !parts.length || parts.some(tag => part.test(tag));
  }

  function forms(query, byName, splitGloss) {
    if (!singleWord.test(query) || byName.has(query)) return [];
    const matches = new Set();
    const add = (name, part) => {
      const word = byName.get(name);
      if (word && (!part || supports(word, part, splitGloss))) matches.add(word);
    };
    for (const headword of irregular.get(query) || []) add(headword);

    if (query.endsWith('s')) {
      const stem = query.slice(0, -1);
      const withoutEs = query.slice(0, -2);
      if (/[^aeiou]ies$/.test(query)) add(`${query.slice(0, -3)}y`, presentOrPlural);
      if (query.endsWith('es') && (sibilant.test(withoutEs) || withoutEs.endsWith('o'))) add(withoutEs, presentOrPlural);
      if (/zzes$/.test(query)) add(query.slice(0, -3), presentOrPlural);
      if (!sibilant.test(stem)) add(stem, presentOrPlural);
    }

    if (query.endsWith('ed')) {
      const stem = query.slice(0, -2);
      if (/[^aeiou]ied$/.test(query)) add(`${query.slice(0, -3)}y`, finiteVerb);
      if (doubleConsonant.test(stem)) add(stem.slice(0, -1), finiteVerb);
      if (!/(?:e|[^aeiou]y)$/.test(stem)) add(stem, finiteVerb);
      add(query.slice(0, -1), finiteVerb);
    }

    if (query.endsWith('ing')) {
      const stem = query.slice(0, -3);
      if (query.endsWith('ying')) add(`${query.slice(0, -4)}ie`, finiteVerb);
      if (doubleConsonant.test(stem)) add(stem.slice(0, -1), finiteVerb);
      if (!stem.endsWith('ie')) add(stem, finiteVerb);
      if (!/(?:e|i|y)$/.test(stem)) add(`${stem}e`, finiteVerb);
    }

    const degree = /^(.*?)(er|est)$/.exec(query);
    if (degree) {
      const stem = degree[1];
      if (/[^aeiou]i$/.test(stem)) add(`${stem.slice(0, -1)}y`, comparative);
      if (doubleConsonant.test(stem)) add(stem.slice(0, -1), comparative);
      if (!/(?:e|[^aeiou]y)$/.test(stem)) add(stem, comparative);
      add(`${stem}e`, comparative);
    }

    if (query.endsWith('ly')) {
      const stem = query.slice(0, -2);
      if (/[^aeiou]i$/.test(stem)) add(`${stem.slice(0, -1)}y`, adjective);
      if (query.endsWith('bly')) add(`${query.slice(0, -1)}e`, adjective);
      if (query.endsWith('ically')) add(query.slice(0, -4), adjective);
      if (query.endsWith('lly')) add(query.slice(0, -1), adjective);
      if (!/(?:ll|[^aeiou]y)$/.test(stem)) add(stem, adjective);
    }
    return [...matches];
  }

  function oneEdit(a, b) {
    if (a.length > b.length) [a, b] = [b, a];
    if (b.length - a.length > 1) return false;
    let index = 0;
    while (index < a.length && a[index] === b[index]) index++;
    if (a.length < b.length) return a.slice(index) === b.slice(index + 1);
    if (index === a.length) return false;
    if (a.slice(index + 1) === b.slice(index + 1)) return true;
    // An adjacent transposition counts as one edit, as in the shape comparison on word cards.
    return a[index] === b[index + 1] && a[index + 1] === b[index] && a.slice(index + 2) === b.slice(index + 2);
  }

  function suggestions(query, byName) {
    if (!singleWord.test(query)) return [];
    const matches = [];
    for (const [name, word] of byName) {
      if (oneEdit(query, name) && singleWord.test(name)) matches.push(word);
    }
    return matches.sort((a, b) => Math.abs(a.word.length - query.length) - Math.abs(b.word.length - query.length)
      || a.word.localeCompare(b.word)).slice(0, 6);
  }

  return { forms, suggestions };
})();

if (typeof module !== 'undefined') module.exports = WordLookup;
