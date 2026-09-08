/**
 * Trimmed excerpt of a real RisuAI multi-scene greeting ported through
 * LumiRealm (card "sex&sex fantasy", 26 `{{#when}}` scenes in one message).
 * Only the `$messageSelector` header, the s0 placeholder block, and the s1
 * scene block are kept; asset names beyond the one sprite tag are stripped.
 */

export const GREETING_HEADER = "$messageSelector";

export const GREETING_S0_BLOCK = "{{#when::{{equal::{{getvar::firstMessage}}::s0}}}}\nPlease enjoy and wander freely as you wish.\n{{/when}}";

export const GREETING_S1_BLOCK = "{{#when::{{equal::{{getvar::firstMessage}}::s1}}}}\n\nThe cradle of humanity dominating the center of the continent, the heart of the Holy Empire of Ezerta\u2014the capital city of Valkyria. At its very center stood the imperial palace, 'Sol Eterna', where the supreme sovereignty of the empire resided. Inside, the Grand Audience Chamber revealed its solemn and magnificent grandeur, flanked endlessly by exquisitely sculpted columns of white jade marble.\n\nWarm sunlight streamed through the high skylights of the vaulted dome ceiling, colliding with fine particles of mana drifting in the air to scatter like a gentle golden dust. A quiet majesty mingled with a light tension throughout the hall, yet there was no sign of urgency or peril; it was a serene, orderly atmosphere of absolute imperial rule.\n\nOn either side of the audience chamber, imperial guards clad impeccably in silver-white plate armor stood arrayed without the slightest twitch. Beyond the crimson carpet running down the center, only the rhythmic rustle of parchment and the soft scratching of quills from scribes sorting through petitions from across the provinces echoed through the hall.\n\n<pimg=\"aurelia\">\n\nAt the highest tier of the dais rested a throne of pure white and gold. Seated upon it was the 22nd ruler of the Ezerta Empire, lauded across the realm as the 'Immortal Sun'\u2014Empress Aurelia de Ezerta.\n\nTrue to the rumors that the goddess's blessing had halted her aging for over a century, she preserved the flawless, unblemished jade skin and radiant maturity of a woman in her late twenties to early thirties. Her dazzling platinum-blonde hair, neatly arranged beneath the imperial crown, cascaded smoothly over her crimson velvet cape. Her golden eyes, shining like the sun as she scrutinized reports and documents, radiated an unwavering, intellectual composure.\n\n\"The next agenda is the irrigation canal maintenance in the lower noble territories and the barrier mana stone requisition for the Magic Tower. The treasurer's seal of approval is absent; reject it, have it amended, and resubmit it by noon tomorrow.\"\n\nThe Empress's low, resonant voice reached every corner of the Grand Audience Chamber with crystalline clarity, devoid of flamboyant flourish or heightened emotion. It was a voice that embodied restrained bureaucratic perfection within absolute charisma. The protocol officers bowed in unison as they retrieved the documents, while other nobles and foreign envoys waiting at the audience line held their breath in patient silence, awaiting their turn.\n\nIn the outer gallery of the hall, designated for general observation and open waiting, a comparatively relaxed air circulated, well removed from the strict protocol of the central hall. Among the outlanders who had just arrived in the empire and visitors awaiting identification, no one spoke rashly or cast rude glances at those nearby.\n\nOnly a tranquil silence lingered, offering a vantage point one step back to take in the breathtaking vista of the colossal palace and observe the Iron Empress maintaining the order of the continent as she conducted the realm's affairs.\n{{/when}}";

/** The raw stored message text: header + placeholder scene + one real scene. */
export const RAW_GREETING = `${GREETING_HEADER}\n\n${GREETING_S0_BLOCK}\n\n${GREETING_S1_BLOCK}\n`;

/** Inner text of the s1 block, as LumiRealm's interceptor returns it when s1 is selected. */
export const S1_SCENE_TEXT = GREETING_S1_BLOCK
  .replace(/^\{\{#when::[^\n]*\}\}/, "")
  .replace(/\{\{\/when\}\}$/, "")
  .trim();

/** Inner text of the s0 block (the "nothing selected" placeholder line). */
export const S0_PLACEHOLDER_TEXT = GREETING_S0_BLOCK
  .replace(/^\{\{#when::[^\n]*\}\}/, "")
  .replace(/\{\{\/when\}\}$/, "")
  .trim();

/** What `macros.resolve` returns with LumiRealm active and s1 selected. */
export const RESOLVED_GREETING_S1 = `${GREETING_HEADER}\n\n\n\n${S1_SCENE_TEXT}\n`;

/** What `macros.resolve` returns with LumiRealm active and nothing selected (s0). */
export const RESOLVED_GREETING_S0 = `${GREETING_HEADER}\n\n${S0_PLACEHOLDER_TEXT}\n\n\n`;
