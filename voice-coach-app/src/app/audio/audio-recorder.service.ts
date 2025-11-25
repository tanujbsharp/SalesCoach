import { Injectable } from '@angular/core';
import { DocumentStateService } from '../services/document-state.service';

@Injectable({ providedIn: 'root' })
export class AudioRecorderService {
  private readonly API_BASE = 'http://127.0.0.1:8000';
  private mediaRecorder!: MediaRecorder;
  private chunks: Blob[] = [];

  // Let components listen for AI feedback (score, text, audio)
  public onResponse: (data: {
    score: number;
    feedback: string;
    audio_url: string;
    transcript?: string;
  }) => void = () => {};

  constructor(private documentState: DocumentStateService) {}

  startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      this.chunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        this.uploadAudio();
      };

      this.mediaRecorder.start();
    }).catch(error => {
      console.error("❌ Microphone access denied:", error);
    });
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  private uploadAudio() {
    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', blob, 'input.webm');

    const docId = this.documentState.getDocumentId();
    const endpoint = docId ? `${this.API_BASE}/api/audio?documentId=${docId}` : `${this.API_BASE}/api/audio`;

    fetch(endpoint, {
      method: 'POST',
      body: formData
    })
    .then(res => res.json())
    .then(data => {
      console.log("✅ Audio response received:", data);

      // Play the AI feedback audio
      if (data.audio_url) {
        const audio = new Audio(`${this.API_BASE}/${data.audio_url}`);
        audio.play();
      }

      // Emit feedback (plus transcript) so UI can show results
      this.onResponse({
        score: data.score,
        feedback: data.feedback,
        audio_url: data.audio_url,
        transcript: data.transcript
      });
    })
    .catch(error => {
      console.error("❌ Failed to upload audio:", error);
    });
  }
}