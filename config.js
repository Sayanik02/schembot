// ============================================================
//   CONFIG — edit only this file (env vars override the server)
// ============================================================

module.exports = {

  server: {
    host:    process.env.MC_HOST    || 'aeadasde.aternos.me',
    port:    parseInt(process.env.MC_PORT || '57199', 10),
    // Version the BOT speaks. Your server can be newer (26.2) if ViaVersion is installed on it.
    version: process.env.MC_VERSION || '26.1',
  },

  bot: {
    usernames: ['SchemBot_Atlas', 'SchemBot_Forge', 'SchemBot_Quarry', 'SchemBot_Mason', 'SchemBot_Archer'],
    reconnectDelay: 5000,
    // null = anyone who types "schem ..." in chat / console can control the bot.
    // Or restrict, e.g. ['Server', 'YourName']
    allowedUsers: null,
  },

  schematic: {
    dir:       './schematics',   // (a Railway volume is used automatically if attached)
    maxVolume: 60000000,         // refuse anything bigger than this many blocks (width*height*length)
    pasteAir:  true,             // true = air in the file clears the area (clean paste). false = keep existing terrain
    skippedBecomeAir: true,      // blocks the server doesn't know: true = leave air, false = leave whatever is already there

    // Swap blocks before building. Left side = what the file has, right side = what to place instead.
    // Base names keep their properties (facing, half...). Use a full state on the left to match exactly.
    // Examples:
    //   'minecraft:some_removed_block': 'minecraft:stone',
    //   'minecraft:grass':              'minecraft:short_grass',
    swaps: {},
  },

  build: {
    opDelay:       20,       // ms between commands (raise to 40-60 if the server lags)
    tileSize:      128,      // blocks per side of one forceloaded work area (max ~190)
    gamemode:      'spectator', // bot can't suffocate inside builds or fall
    forceloadWait: 2500,     // ms to wait for chunks after forceloading (+ ~20ms per chunk)
    retryTile:     2,        // re-run a work area this many times if the server reported errors
    saveEvery:     50,       // save progress every N commands
  },

  limits: { minY: -64, maxY: 319 },   // world height of the server

};
