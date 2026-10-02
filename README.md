# Minecraft Schematic Builder Bot

Give it a `.schem`, `.litematic` or `.nbt` file and it builds the structure in your world using fast `/fill` commands.
Blocks the server doesn't know are skipped automatically. Progress is saved, so restarts resume where they stopped.

## Setup
1. Edit `config.js` (or set env vars `MC_HOST`, `MC_PORT`, `MC_VERSION`).
   - `version` is what the **bot** speaks. Mineflayer supports up to 26.1. If your server is 26.2, install **ViaVersion** on it.
2. Make the bot OP: in the server console run `op SchemBot_Atlas` (the name is printed in the bot's log).
3. Deploy (Railway: `npm install` then `npm start`). Optional env var `ADMIN_TOKEN` locks the page: open `/?token=YOURTOKEN`.
   Attach a Railway volume so uploads and progress survive redeploys.

## Using it
Open your Railway URL:
1. **Upload** a schematic and press **Load**. The preview shows it from above (or one layer at a time).
2. Set the **origin** (the build's lowest corner) or press "Use bot position".
3. **Check blocks** asks the server which blocks it knows (unknown ones are listed and skipped), then **Start**.

Console commands (prefix with `say `): `schem list`, `schem load <file>`, `schem origin x y z`, `schem here`,
`schem analyze`, `schem start`, `schem stop`, `schem status`, `schem reset`.

## Good to know
- The bot must be OP, and `sendCommandFeedback` should stay on (needed to detect unknown blocks).
- Air in the file clears the area (`pasteAir` in config). Set it to `false` to keep existing terrain.
- Swap blocks in `config.js` (`schematic.swaps`), e.g. replace a removed block with a similar one.
- Torches, doors, rails etc. are placed after solid blocks, and water/lava last, so nothing pops off.
- Not supported yet: rotating/mirroring, chest contents, sign text, entities (item frames, paintings).
- Re-running a finished build is safe: `schem reset`, then start again, to repair anything you broke.
- Offline test: `npm test`.
