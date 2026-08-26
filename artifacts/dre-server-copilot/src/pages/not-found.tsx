import { useRoute } from "wouter";

export default function NotFound() {
  const [match] = useRoute("/__mockup");
  if (match) return null;

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <h1 className="mb-2 text-2xl font-bold tracking-tight text-primary">Terminal Offline</h1>
        <p className="text-sm text-muted-foreground uppercase tracking-widest">
          Error 404
        </p>
      </div>
    </div>
  );
}
