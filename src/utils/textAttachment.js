// textAttachment.js: the text files the bot attaches (ticket transcripts).
//
// GH #324: Discord guesses the charset of a text file it previews, and a UTF-8 file with Arabic in it was shown
// as Thai-looking letters. A UTF-8 byte order mark (U+FEFF, bytes EF BB BF) in front tells Discord (and Notepad,
// and browsers) that the file is UTF-8. The text itself is not changed.
export const UTF8_BOM = String.fromCharCode(0xFEFF);

/** The UTF-8 bytes of `text` with one byte order mark in front (none added when the text already starts with it). */
export function utf8TextFile(text) {
  const body = String(text ?? '');
  return Buffer.from(body.startsWith(UTF8_BOM) ? body : UTF8_BOM + body, 'utf8');
}
