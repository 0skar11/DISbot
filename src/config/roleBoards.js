// roleBoards.js — emoji reaction-role boards (GH #326).
//
// A board is one message: a list of "emoji ┃ @role" lines with the bot's reactions under it. A member
// reacts to get the role and removes the reaction to drop it (src/services/roleBoardService.js).
// Nothing here is posted on startup or deploy: an owner posts the boards with
//   /publish-board role-boards channel:<channel>
// and running it again edits the same messages instead of posting new ones.
//
// Each role line is { emoji, roleId } or { emoji, name }:
//   • emoji  — the reaction members click: a normal emoji ('🎮') or a server emoji ('<:name:id>', '<a:name:id>').
//   • roleId — the role's id (right click the role → Copy Role ID).
//   • name   — the role's name, looked up in the server the board is posted in (case, spaces and symbols
//              are ignored, so 'brawl stars' finds "Brawl Stars"). Two roles with the same name are skipped:
//              use roleId for those.
// A role that does not exist, is above the bot, is a bot/integration role or has staff permissions is
// skipped and listed in the command's reply; it is never shown as "@unknown-role". Discord allows at most
// 20 different reactions on one message, so a board holds at most 20 roles.

export const ROLE_BOARDS = [
  {
    key: 'games',
    title: '🎮 ┃ Games',
    description: 'دوس على رياكشن اللعبة اللي بتلعبها عشان تاخد رولها، وشيل الرياكشن عشان تشيل الرول.',
    color: 0x5865f2,
    // The game roles from the board in the report. The names are found in the server; the emojis are
    // defaults and can be changed to the server's own game icons ('<:name:id>').
    // emojiName: the server emoji uploaded to CHAOS Club (the bot sees it in every server, so Zenith can use it).
    // emoji is the fallback. A role that does not exist in the server is skipped, never shown.
    roles: [
      { emoji: '🚀', emojiName: 'game_rocketleague', name: 'Rocket League' },
      { emoji: '🧱', emojiName: 'game_roblox', name: 'Roblox' },
      { emoji: '🔫', emojiName: 'game_pubg', name: 'PUBG' },
      { emoji: '🗡️', emojiName: 'game_brawlhalla', name: 'Brawlhalla' },
      { emoji: '⭐', emojiName: 'game_brawlstars', name: 'Brawl Stars' },
      { emoji: '🎯', emojiName: 'game_valorant', name: 'Valorant' },
      { emoji: '⛏️', emojiName: 'game_minecraft', name: 'Minecraft' },
      { emoji: '🛸', emojiName: 'game_amongus', name: 'Among Us' },
      { emoji: '🕵️', emojiName: 'game_codenames', name: 'Codenames' },
      { emoji: '⚔️', emojiName: 'game_combatmaster', name: 'Combat Master' },
    ],
  },
  {
    key: 'friends',
    title: '💞 ┃ الحبايب',
    description: 'دوس على الرياكشن عشان تاخد رول الحبايب، وشيله عشان تشيل الرول.',
    color: 0xff73b3,
    // PLACEHOLDER — waiting for the owner: the friends (الحبايب) role ids and one emoji per role, e.g.
    //   { emoji: '💜', roleId: '<role id from the owner>' },
    // While this list is empty the friends board is not posted (the command says so).
    roles: [],
  },
];

export function getRoleBoardConfig(key) {
  return ROLE_BOARDS.find((board) => board.key === key) || null;
}
