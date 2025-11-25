import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VoiceModalComponent } from '../voice-modal/voice-modal.component';
import { Router } from '@angular/router';
import { DocumentStateService } from '../../services/document-state.service';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, VoiceModalComponent],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent {
  messages: { from: 'user' | 'bot'; text: string }[] = [];
  userText: string = '';
  showVoiceModal = false;
  readonly API_BASE = 'http://127.0.0.1:8000';

  constructor(private router: Router, private documentState: DocumentStateService) {
    this.loadInitialQuestion();
  }

  private get documentId() {
    return this.documentState.getDocumentId();
  }

  private questionUrl() {
    return this.documentId ? `${this.API_BASE}/api/question?documentId=${this.documentId}` : `${this.API_BASE}/api/question`;
  }

  loadInitialQuestion() {
    fetch(this.questionUrl())
      .then(res => res.json())
      .then(data => {
        this.messages.push({ from: 'bot', text: data.question });
      });
  }

  submitText() {
    if (!this.userText.trim()) return;

    const input = this.userText;
    const rubric = this.getRubric();

    // Display censored if abusive
    const censored = this.containsAbuse(input) ? '****' : input;
    this.messages.push({ from: 'user', text: `Your Response: ${censored}` });
    this.userText = '';

    const payload: any = { text: input, rubric };
    if (this.documentId) payload.documentId = this.documentId;

    fetch(`${this.API_BASE}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        this.messages.push({
          from: 'bot',
          text: `Coaching Feedback:<br><br>${data.feedback}`
        });

        // Auto-ask next question
        return fetch(this.questionUrl());
      })
      .then(res => res.json())
      .then(qData => {
        this.messages.push({ from: 'bot', text: qData.question });
      })
      .catch(err => {
        console.error('Error:', err);
      });
  }

  handleVoiceResponse(e: { question: string; answer: string }) {
    const input = e.question;
    const rubric = this.getRubric();
    const censored = this.containsAbuse(input) ? '****' : input;

    this.messages.push({ from: 'user', text: `Your Response: ${censored}` });
    this.messages.push({ from: 'bot', text: `Coaching Feedback:<br><br>${e.answer}` });

    fetch(this.questionUrl())
      .then(res => res.json())
      .then(qData => {
        this.messages.push({ from: 'bot', text: qData.question });
      });
  }

  containsAbuse(input: string): boolean {
    const badWords = ['fuck', 'shit', 'bitch', 'asshole']; // Add more if needed
    const lowered = input.toLowerCase();
    return badWords.some(word => lowered.includes(word));
  }

  getRubric() {
    try {
      return JSON.parse(localStorage.getItem('salesRubric') || '[]');
    } catch {
      return [];
    }
  }

  openVoiceModal() {
    this.showVoiceModal = true;
  }

  goToInstructions() {
    this.router.navigate(['/instructions']);
  }

  goToUpload() {
    this.router.navigate(['/']);
  }
}