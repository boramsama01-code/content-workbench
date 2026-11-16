# SNS automation references checked for Studio upgrade

Checked: 2026-11-16 02:11 UTC (11:11 KST). Exact star counts are a snapshot.
Scope: selected relevant results from GitHub repository searches sorted by `stars desc`; this is not an exhaustive global leaderboard. Generic workflow/research tools are separated from Instagram writing skills.

| Project | Stars | License | What Studio can learn |
|---|---:|---|---|
| [Postiz](https://github.com/gitroomhq/postiz-app) | 41,685 | AGPL-3.0 | Calendar, draft/scheduled/published states, channel adapters, public API/webhooks, separate content generation from publishing |
| [awesome-n8n-templates](https://github.com/enescingoz/awesome-n8n-templates) | 26,427 | GitHub: Other/NOASSERTION | Reusable multi-stage workflows; broad workflow collection, not an Instagram-specific application |
| [social-auto-upload](https://github.com/dreammis/social-auto-upload) | 16,568 | MIT | Asset/upload queue organization; advertised platforms are Chinese platforms, TikTok and YouTube, not an Instagram writing engine |
| [instagram-agent-skill](https://github.com/Jakeschincariol/instagram-agent-skill) | 6,642 | MIT | Screenshot-matching 13-task library, shared voice profile, three distinct hooks, script/on-screen text/timing, caption checks, human rewrite, performance review |
| [social-media-research-skills](https://github.com/ScrapeCreators/social-media-research-skills) | 6,525 | MIT | Research workflows, outlier/competitor/comment/trend analysis; depends on ScrapeCreators service for collection |
| [Mixpost](https://github.com/inovector/mixpost) | 3,940 | MIT | Calendar, scheduling, content management |
| [LangChain social-media-agent](https://github.com/langchain-ai/social-media-agent) | 3,020 | MIT | Source URL ingestion, draft generation, editing and accept/reject loop; implementation targets Twitter and LinkedIn |
| [blacktwist/social-media-skills](https://github.com/blacktwist/social-media-skills) | 659 | MIT | Text-first writing strategy; separate from the screenshot's Instagram pack |

## Screenshot match

The screenshot's 81.4-point contract hook, 9.6-point greeting hook, profile rubric, caption preview, and 13 tasks match Jakeschincariol/instagram-agent-skill. Its current count is 6,642, not the older screenshot's 4,231. Match rests on task/example contents, not the star count.

## Three concrete changes to adopt

1. Shared writing voice and proof bank: every production task reads the same profile. Keep approved facts and numbers separate from writing preferences. Actual revised drafts are stronger style evidence than casual messages. Preserve the user's conversational Korean, specific titles, and category voice while cutting filler and increasing clarity.
2. Stage the work: brief and evidence -> three genuinely distinct hooks -> selected hook -> card/reel copy -> timing or slide sequence -> caption preview -> Korean editorial checks -> reviewable final version. Save rejected/accepted edits as explicit writing preferences instead of silently overfitting to one result.
3. Feed performance back using comparable organic cohorts: separate ads, formats, age at measurement and length. Keep 3-second retention, average watch time and end retention as different metrics. Use account medians for context and clearly mark small samples; never describe an editorial score as an Instagram ranking score.

## What not to copy as fact

The pack's own README says its hook scorer distinguished a creator's hits from misses at AUC 0.56, close to chance, on 74 YouTube Shorts hooks. AUC 0.83 was for deliberately weak hooks versus real hooks, not future Reel virality. The visible 81.4 score is a local heuristic score, not an empirical probability or Instagram algorithm score.

The pack's English word counts/WPM, regexes, typography detector and fixed timing defaults need Korean adaptation. Its universal claims that no views imply a hook problem, no follows imply a profile problem, or all non-follower reach proves recommendation discovery are too strong and should not enter the app.

A 125-character caption preview is a useful editorial approximation, not a guaranteed Instagram UI cutoff across all devices and surfaces. Names, numbers, revenue, deadlines and outcomes must come from supplied/verified evidence, never be invented merely to strengthen a hook.

Use architecture and editorial patterns; no third-party code has been installed or copied into the Studio application as part of this research.

## Primary URLs inspected

- https://api.github.com/repos/gitroomhq/postiz-app
- https://api.github.com/repos/Jakeschincariol/instagram-agent-skill
- https://github.com/Jakeschincariol/instagram-agent-skill
- https://raw.githubusercontent.com/Jakeschincariol/instagram-agent-skill/main/templates/voice.md
- https://raw.githubusercontent.com/Jakeschincariol/instagram-agent-skill/main/skills/ig-reel/SKILL.md
- https://raw.githubusercontent.com/Jakeschincariol/instagram-agent-skill/main/skills/ig-audit/SKILL.md
- https://raw.githubusercontent.com/langchain-ai/social-media-agent/main/README.md
- https://raw.githubusercontent.com/gitroomhq/postiz-app/main/README.md
