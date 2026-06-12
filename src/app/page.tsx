import { Mail, AlertCircle } from "lucide-react";
import { signInWithGoogle } from "@/app/actions/auth";

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-base">
      <div className="w-full max-w-sm flex flex-col items-center gap-8 text-center">

        {/* Logo */}
        <div
          className="neu-card flex items-center justify-center"
          style={{ width: 72, height: 72, borderRadius: 20 }}
        >
          <Mail size={32} color="#a55eea" strokeWidth={1.75} />
        </div>

        {/* Headlines */}
        <div className="flex flex-col gap-3">
          <h1
            className="text-3xl font-semibold text-white leading-tight"
            style={{ letterSpacing: "-0.02em" }}
          >
            Your inbox, finally<br />in control.
          </h1>
          <p className="text-base leading-relaxed" style={{ color: "#8888a0" }}>
            Scan, classify, and clean thousands of emails in minutes.
          </p>
        </div>

        {/* Auth expired alert */}
        {params.message === 'gmail_auth_expired' && (
          <div className="neu-inset flex items-center gap-3 w-full text-left" style={{ padding: '12px 16px', borderRadius: 12 }} role="alert">
            <AlertCircle size={15} color="#e84141" strokeWidth={1.75} style={{ flexShrink: 0 }} />
            <p style={{ fontSize: 13, color: '#e84141', lineHeight: 1.4 }}>
              Your Gmail access expired. Sign in again to continue.
            </p>
          </div>
        )}

        {/* Sign in button */}
        <form action={signInWithGoogle} className="w-full">
          <button
            type="submit"
            className="neu-button w-full flex items-center justify-center gap-3 px-6 py-4 text-white font-medium text-base"
          >
            {/* Google G logo */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
        </form>

        {/* Footnote */}
        <p className="text-xs" style={{ color: "#555568" }}>
          Gmail only. Your data never leaves your account.
        </p>
      </div>
    </main>
  );
}
