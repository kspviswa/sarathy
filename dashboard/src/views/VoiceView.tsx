import { VoiceSession, type VoiceSessionProps } from "@/components/VoiceSession";

type VoiceViewProps = Omit<VoiceSessionProps, "variant">;

export function VoiceView(props: VoiceViewProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="voice-view">
      <VoiceSession variant="desktop" {...props} />
    </div>
  );
}

export default VoiceView;
