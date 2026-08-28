# `artifacts/mockup-sandbox` — design/prototype sandbox

**This is a prototype and design sandbox. It is not the production DRE
frontend and it is not a deployment source for anything shipped.** The
production frontend is [`artifacts/dre-server-copilot/`](../dre-server-copilot/README.md).

Per its own `.replit-artifact/artifact.toml`, this workspace is configured
as `kind = "design"` with a component preview server
(`pnpm --filter @workspace/mockup-sandbox run dev`) mounted at `/__mockup`
— it exists to preview isolated UI components/mockups (see
`mockupPreviewPlugin.ts` and `src/.generated/mockup-components.ts`), not to
run as an application.

It shares the same shadcn/Radix UI primitive set as the production frontend
(`src/components/ui/`), which is why the two directories look similar at a
glance — but nothing here is wired to the DRE FastAPI backend, to
`sessionStorage` auth, or to any real API route. Treat any UI shown here as
a visual/interaction sketch only.

Do not point deployment tooling, CI image builds, or production build
scripts at this directory. No individual README is provided for its
`src/components/ui/` primitives — they are the same generated boilerplate
class as in the production app and are not independently documented per the
root README's proportional-detail policy.
