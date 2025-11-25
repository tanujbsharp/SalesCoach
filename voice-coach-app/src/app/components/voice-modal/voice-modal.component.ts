import {
  Component,
  ElementRef,
  EventEmitter,
  Output,
  ViewChild,
  AfterViewInit,
  ChangeDetectorRef,
  Input
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DocumentStateService } from '../../services/document-state.service';

@Component({
  selector: 'app-voice-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './voice-modal.component.html',
  styleUrls: ['./voice-modal.component.css']
})
export class VoiceModalComponent implements AfterViewInit {
  @Input() prompt?: string;
  @Input() variant: 'overlay' | 'card' = 'overlay';
  @Output() onClose = new EventEmitter<void>();
  @Output() onTranscriptReady = new EventEmitter<{ transcript: string; feedback: string; score: number }>();
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;

  transcript = '';
  isProcessing = false;
  isSpeaking = false;
  listening = false;

  mediaRecorder: MediaRecorder | null = null;
  audioChunks: Blob[] = [];
  stream: MediaStream | null = null;

  showCountdown = true;
  countdown = 3;
  displayTime = '02:30';
  timeLeft = 150; // 2m 30s
  timerInterval: any;

  private readonly API_BASE = 'http://127.0.0.1:8000';

  constructor(private cd: ChangeDetectorRef, private documentState: DocumentStateService) {}

  ngAfterViewInit() {
    this.startCountdown();
  }

  startCountdown() {
    const countdownInterval = setInterval(() => {
      this.countdown -= 1;
      this.cd.detectChanges();

      if (this.countdown === 0) {
        clearInterval(countdownInterval);
        this.showCountdown = false;
        this.startMic();
        this.startTimer();
      }
    }, 1000);
  }

  async startMic() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.setupRecorder(this.stream);
      this.startWaveform(this.stream);
    } catch (err) {
      console.error('Mic access failed:', err);
    }
  }

  setupRecorder(stream: MediaStream) {
    this.mediaRecorder = new MediaRecorder(stream);
    this.audioChunks = [];

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.audioChunks.push(event.data);
    };

    this.mediaRecorder.start();
    this.listening = true;
  }

  startTimer() {
    this.updateDisplayTime();
    this.timerInterval = setInterval(() => {
      this.timeLeft--;
      this.updateDisplayTime();
      this.cd.detectChanges();

      if (this.timeLeft === 0) {
        clearInterval(this.timerInterval);
        this.confirm(); // auto-submit
      }
    }, 1000);
  }

  updateDisplayTime() {
    const min = Math.floor(this.timeLeft / 60).toString().padStart(2, '0');
    const sec = (this.timeLeft % 60).toString().padStart(2, '0');
    this.displayTime = `${min}:${sec}`;
  }

  async confirm() {
    if (!this.mediaRecorder) return;

    this.isProcessing = true;
    this.listening = false;
    this.mediaRecorder.stop();

    this.mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('file', audioBlob, 'input.webm');

      try {
        const docId = this.documentState.getDocumentId();
        const endpoint = docId ? `${this.API_BASE}/api/audio?documentId=${docId}` : `${this.API_BASE}/api/audio`;

        const res = await fetch(endpoint, {
          method: 'POST',
          body: formData
        });
        const data = await res.json();

        this.isProcessing = false;
        this.isSpeaking = true;

        this.onTranscriptReady.emit({
          transcript: data.transcript || '[voice input]',
          feedback: data.feedback,
          score: data.score ?? 0
        });

        this.cleanup();
        this.onClose.emit();
        this.isSpeaking = false;
      } catch (err) {
        console.error('❌ Failed to process audio:', err);
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert('There was an error processing your voice response.');
        }
        this.isProcessing = false;
      }
    };
  }

  cancel() {
    clearInterval(this.timerInterval);
    this.cleanup();
    this.onClose.emit();
    this.isSpeaking = false;
  }

  cleanup() {
    this.mediaRecorder?.stop();
    this.stream?.getTracks().forEach(t => t.stop());
  }

  startWaveform(stream: MediaStream) {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    source.connect(analyser);
    analyser.fftSize = 64;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      analyser.getByteFrequencyData(dataArray);
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = 8;
      const gap = 4;
      for (let i = 0; i < dataArray.length; i++) {
        const val = dataArray[i];
        const height = val / 2;
        const x = i * (barWidth + gap);
        if (ctx) {
          ctx.fillStyle = '#0af';
          ctx.fillRect(x, canvas.height - height, barWidth, height);
        }
      }
      requestAnimationFrame(draw);
    };

    draw();
  }
}