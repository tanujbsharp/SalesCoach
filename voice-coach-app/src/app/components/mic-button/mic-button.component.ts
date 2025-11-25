import { Component, EventEmitter, Output } from '@angular/core';
import { AudioRecorderService } from '../../audio/audio-recorder.service';

export interface VoiceResponsePayload {
  score: number;
  feedback: string;
  transcript?: string;
}

@Component({
  selector: 'app-mic-button',
  standalone: true,
  templateUrl: './mic-button.component.html',
  styleUrls: ['./mic-button.component.css']
})
export class MicButtonComponent {
  @Output() responseReceived = new EventEmitter<VoiceResponsePayload>();
  recording = false;

  constructor(private recorder: AudioRecorderService) {
    this.recorder.onResponse = (data) => {
      this.recording = false;
      this.responseReceived.emit(data);
    };
  }

  toggleRecording() {
    this.recording = !this.recording;
    this.recording ? this.recorder.startRecording() : this.recorder.stopRecording();
  }
}