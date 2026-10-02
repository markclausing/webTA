# The score board

Not deployed yet: `DEFAULT_BOARD` in `src/config.js` is empty, so every
browser keeps its own board. The Worker answers `GET /highscores` and
`POST /highscores`, holds one Durable Object, and can have an admin key set for
taking rows off again.

Two commands and the board is shared:

```sh
npx wrangler login
npx wrangler deploy          # from this directory
```

Wrangler prints an address like `https://webta.your-name.workers.dev`. Put it
in `src/config.js` as `DEFAULT_BOARD` and every copy of the page posts its board
there and reads everybody else's back.

Nothing else is needed. There is no multiplayer in this game, so there is no
relay to run and no sockets to keep alive: the Worker answers two calls, `GET
/highscores` and `POST /highscores`, and holds one Durable Object.

## Trying it without deploying

`npm start` in the repository root serves the game *and* the same two calls from
`server/board.js`, keeping the board in `highscores.json`. The browser cannot
tell the difference. Use `?board=` in the address to point a page at any other
one:

```
http://localhost:8080/?board=https://webta.your-name.workers.dev
```

## The broom

A public list with no accounts on it collects something you would rather it did
not, sooner or later.

```sh
npx wrangler secret put ADMIN_KEY

# one row, by id, and it stays off even though the browser that set it still has it
curl -X POST -H "x-admin-key: KEY" -H 'content-type: application/json' \
  -d '{"ids":["m8x1a-9qz"]}' https://webta.your-name.workers.dev/highscores/remove

# or all of them
curl -X POST -H "x-admin-key: KEY" https://webta.your-name.workers.dev/highscores/reset
```

With no `ADMIN_KEY` set, both doors return 404 - which is the right default for
anybody who deploys this and never reads this file. If you keep a copy of the
key on disk, `worker/.admin-key` is covered by `.gitignore`.

## What it will and will not accept

Every row that arrives goes through the same `cleanEntry` the browser runs. A
defeat, a tie or a score over sixty does not survive it, names are three characters of `A-Z 0-9 -`, and a board of more than
64KB is refused outright. That is the whole of the validation, and it is
deliberately not more: this is a score board for friends, not an anti-cheat
system, and anybody determined to put a fake result on it can.

