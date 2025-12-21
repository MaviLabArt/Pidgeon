# Title
I built Pidgeon.lol, a calm privacy first Nostr scheduler, and you can self host the DVM

# Post
[Pidgeon logo](https://pidgeon.lol/pidgeonicon.svg)

[Pidgeon wordmark](https://pidgeon.lol/pidgeonwordmark.svg)

Hey folks, I am honestly a bit nervous posting this, but I am also really excited. Pidgeon is live at https://pidgeon.lol

I have been building it because I kept doing the same thing over and over. I would write a note, get pulled into something else, and then it is 2am and I never actually posted it. Or I would want to post at a specific time, different timezone, launch day, remind people tomorrow, and it would just turn into a sticky note mess.

So yeah, I wanted a Buffer style scheduler on Nostr, but I really did not want the classic web2 tradeoff where the price of scheduling is that your entire content and schedule lives in a database forever. That just felt wrong for Nostr.

Pidgeon is my attempt at something that feels simple and calm, but still respects how Nostr works. Keys stay in your hands, relays are the data layer, and privacy is the default as much as it can be.

What it does right now is pretty straightforward. You can write a post and schedule it for later, keep a queue so you can actually see what is coming up, and check your history so you do not lose track. Media uploads work too via NIP 96, and you can log in with common signers like NIP 07, Nostr Connect, or nsec for dev and testing.

It is still early, but it is already genuinely useful for me day to day.

## “Privacy first”… what does that actually mean here?
Under the hood, Pidgeon has a companion DVM that maintains an encrypted job ledger on Nostr as kind `30078`. In plain terms, your scheduled jobs and scheduler state are stored as encrypted shards, so relays cannot read them. The job ledger coordinates are designed to avoid leaking your pubkey in the address itself. Scheduling requests are wrapped using NIP 59, so relays do not get a clean link like “this pubkey is talking to that DVM”.

I am trying hard to make it privacy first without making it annoying or requiring people to be crypto experts just to schedule a post.

One honest caveat though. A scheduler has to publish your post at the right time, so some component needs access to the scheduled content at execution time. If you do not want to rely on a shared hosted DVM, you can run your own DVM.

## Extra privacy/control: run your own DVM
If you self host the DVM, you can point Pidgeon to it and keep the whole scheduling pipeline under your control. To do that, run your own DVM instance, the instructions are in `dvm/README.md` in the repo. Then in the app go to `Settings → Advanced → DVM pubkey` and set your DVM pubkey. If it asks for relays, set those too.

This is also nice if you are a relay operator, a community, or you just want to provide your own instance for friends.

## What I would love feedback on, for real
If you try it, I would love feedback on signer compatibility, relay weirdness, and the UX. Does scheduling feel calm and obvious, or do you get lost and click around until it works. Also tell me what features you would expect from a scheduler that are missing here, I am probably forgetting something obvious.

If you run into bugs, screenshots and a quick note like “what signer” and “what relays” helps a ton. I am shipping changes fast and trying to keep it stable.

## A tiny roadmap, not promises
I want to make it nicer to schedule a thread, schedule multiple notes in one go, and improve queue controls like reorder and bulk actions. I also want better analytics without making the app heavy. And I want support nudges to stay quiet and not annoying.

## Links
App: https://pidgeon.lol (open to all Nostr users)

Source: <PASTE_GITHUB_REPO_URL_HERE>

How it works (protocol and architecture): `docs.md`

If you give it a spin and it feels useful, tell me what you would want next. And if it feels not useful, also tell me, I can take it. I would rather hear the honest version than silence.
