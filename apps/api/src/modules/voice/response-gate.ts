/** Response fencing only; never owns or cancels employee tasks. */
export class VoiceResponseGate {
  epoch = 0;
  blocked = false;
  active = false;
  userSpeaking = false;
  private currentId = '';
  private retired = new Set<string>();
  private inputCompleted = false;

  interrupt(expected = this.epoch): boolean {
    if (expected !== this.epoch || this.blocked) return false;
    if (this.currentId) {
      this.retired.add(this.currentId);
      if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!);
    }
    this.epoch++; this.blocked = true; this.active = false; this.inputCompleted = false;
    return true;
  }

  accept(event: Record<string, unknown>): boolean {
    const type = String(event.type || '');
    const response = event.response as Record<string, unknown> | undefined;
    const id = String(event.response_id || response?.id || '');
    if (type === 'input_audio_buffer.speech_started' || type === 'conversation.item.input_audio_transcription.started') {
      this.userSpeaking = true;
    }
    if (type === 'conversation.item.input_audio_transcription.completed' || type === 'input_audio_buffer.committed') {
      this.userSpeaking = false; this.inputCompleted = true;
      this.active = true;
    }
    if (!type.startsWith('response.')) return true;
    if (id && this.retired.has(id)) return false;
    const boundary = type === 'response.created' || type === 'response.audio.started' || type === 'response.output_audio.started';
    if (this.blocked) {
      // Untagged deltas/done must never reopen an interrupted response.
      if (!boundary || !(id && id !== this.currentId || this.inputCompleted)) return false;
      this.blocked = false;
    }
    if (boundary) {
      if (id && id !== this.currentId || !id && !this.active) this.epoch++;
      this.currentId = id || this.currentId; this.active = true; this.inputCompleted = false;
    }
    if (type.endsWith('.delta')) this.active = true;
    if (type === 'response.done') this.active = false;
    return true;
  }
}
