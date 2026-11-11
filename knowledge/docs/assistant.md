---
ref: project:assistant
title: This assistant
refs: [project:yashos, skill:llms, skill:typescript]
---
An AI assistant that Yash designed and built to answer visitors' questions about Yash's work, by text or by voice. It is made to live inside YashOS, Yash's portfolio site.

What it does: it answers only from a fixed knowledge base of Yash's roles, projects, skills and education, synced from YashOS, plus notes Yash writes. Every answer records which parts of that knowledge it used. When a question goes beyond the knowledge, it first gives the closest real evidence from Yash's work. If the visitor presses the same point, it says that isn't in what it knows rather than guessing, and points the visitor to Yash through Messages.

How it works, in plain words:
- One Cloudflare Worker serves it.
- Each conversation gets its own Durable Object, a small stateful server process that holds that conversation's history and runs the voice loop on the server.
- The language model and the voice come from MiniMax. Text answers come from MiniMax-M3.1-Flash, the only candidate that passed the assistant's safety test; the model for voice is still being chosen by measured speed.
- The whole knowledge base sits at the front of the prompt instead of being searched piece by piece, so the model sees all of it at once and the provider can cache it.
- In voice mode, Deepgram Flux on Cloudflare Workers AI turns speech into text and decides when the visitor has finished speaking. MiniMax then speaks the reply one sentence at a time, so the voice can start before the whole reply is written.
- The model, speech-to-text and voice providers each sit behind a small interface with a scripted stand-in, so the tests and a demo mode run without any API keys.
- An eval suite of about 40 test questions runs against the real model. It checks that the assistant sticks to the knowledge, offers the closest evidence without implying a yes, corrects false premises and ignores instructions pasted into a message. Every answer also passes an output check before it is shown or spoken, and a grounding check that every name and number appears in the knowledge it cited.

The design document and the source code are public, including the assistant's instructions and this knowledge base.
