import { Lock } from "lucide-react"

// The line under a SECRET question's password field, on the desktop card (QuestionBlockCard) and the
// phone answer sheet (RegisteredAnswerSheet) alike: a lock, then what happens to the value. Each caller
// passes only its own type size, tone and margin; the lock and the copy live here.
//
// ONE LINE, down to the phone's 13px at 390pt. The caption it replaced ("Held in memory on the machine
// running Frizz and handed to one command, once. The worker never sees it.") wrapped to two lines on
// every surface. The maintainer, 2026-10-12, on five treatments of the long copy: "They're all so bad …
// shorten it onto one line and then go with something like option A with the hanging lock." Round 2,
// which settled this one, is the mockup sheet `secret-caption-mockups-fixture.tsx`. "Used once" is
// literal: the value is a FIFO the first read spends (packages/server/src/secret-files.ts).
//
// THE LOCK SITS ON THE CAP BAND. Its box is 0.9em square and `self-baseline` in an `items-baseline` row.
// A box S tall standing on the baseline has its ink centre at baseline − S/2, and the cap band's centre
// is baseline − 0.5cap, so the lift is S/2 − 0.5cap. `1cap` is the resolved font's own cap height, so
// the lift holds at the card's 11px and the sheet's 13px with nothing to re-measure. Measured in sans
// (round 2, 2026-10-12): lock ink 8.24px against a 7.75px cap at 11px and 9.74px against 9.16px at 13px,
// centred to 0.01px, so the shackle overshoots the caps by half a pixel the way a round letter does.
// At 1em the lock stood 1.4px taller than the caps and read as oversized. The 2.25 stroke brings it to
// ~0.9px, the weight of the regular text beside it. The ink gap to the text is 5.5px on the card and
// 6.5px on the sheet.
export function SecretCaption({ className }: { className: string }) {
  return (
    <div className={`flex items-baseline gap-[0.3em] ${className}`}>
      <Lock aria-hidden strokeWidth={2.25} className="size-[0.9em] shrink-0 self-baseline translate-y-[calc(0.45em_-_0.5cap)]" />
      <span className="min-w-0 flex-1 text-pretty">Used once. The worker never sees it.</span>
    </div>
  )
}
