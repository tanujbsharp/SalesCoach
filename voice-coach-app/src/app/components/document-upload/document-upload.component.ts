import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DocumentMetadata, DocumentStateService } from '../../services/document-state.service';
import { VoiceModalComponent } from '../voice-modal/voice-modal.component';

type ExperienceStep = 'knowledge' | 'scenario' | 'quiz';
type AnswerMode = 'voice' | 'text';

interface ScenarioResult {
  score: number;
  feedback: string;
  transcript?: string;
}

@Component({
  selector: 'app-document-upload',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, VoiceModalComponent],
  templateUrl: './document-upload.component.html',
  styleUrls: ['./document-upload.component.css']
})
export class DocumentUploadComponent {
  readonly API_BASE = 'http://127.0.0.1:8000';

  selectedFile?: File;
  isUploading = false;
  errorMessage = '';

  documentId?: string;
  documentMeta?: DocumentMetadata;

  knowledgeLoading = false;
  knowledgeSnippet = '';
  knowledgeAudio = '';

  journeyActive = false;
  visibleSteps: ExperienceStep[] = [];

  scenarioLoading = false;
  scenarioQuestion = '';
  scenarioDraft = '';
  scenarioResult?: ScenarioResult;
  scenarioSubmitting = false;
  scenarioModalOpen = false;
  scenarioMode: AnswerMode = 'voice';

  quizLoading = false;
  quizQuestion = '';
  quizOptions: { label: string; text: string }[] = [];
  quizId = '';
  quizResult?: { correct: boolean; explanation: string; answer: string };
  quizSubmitting = false;
  quizSelection?: string;

  constructor(private documentState: DocumentStateService, private router: Router) {
    const meta = this.documentState.getMetadata();
    if (meta) {
      this.documentId = meta.id;
      this.documentMeta = meta;
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.selectedFile = file;
    this.errorMessage = '';
  }

  async uploadDocument() {
    if (!this.selectedFile) return;
    this.isUploading = true;
    this.errorMessage = '';

    const formData = new FormData();
    formData.append('file', this.selectedFile);

    try {
      const res = await fetch(`${this.API_BASE}/api/documents`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error('Failed to upload document.');
      }

      const data = await res.json();
      const meta: DocumentMetadata = {
        id: data.documentId,
        filename: data.filename,
        wordCount: data.wordCount,
        charCount: data.charCount
      };

      this.documentId = meta.id;
      this.documentMeta = meta;
      this.documentState.setDocument(meta);
      // After upload, go straight to the dedicated chat experience.
      this.router.navigate(['/practice']);
    } catch (err: any) {
      this.errorMessage = err?.message || 'Upload failed.';
    } finally {
      this.isUploading = false;
    }
  }

  async loadKnowledgeCard() {
    if (!this.documentId) return;
    this.knowledgeLoading = true;
    this.errorMessage = '';

    try {
      const res = await fetch(`${this.API_BASE}/api/knowledge-card?documentId=${this.documentId}`);
      if (!res.ok) throw new Error('Failed to load knowledge card.');
      const data = await res.json();
      this.knowledgeSnippet = data.snippet;
      this.knowledgeAudio = data.audioUrl ? `${this.API_BASE}/${data.audioUrl}` : '';
    } catch (err: any) {
      this.errorMessage = err?.message || 'Unable to load knowledge card.';
    } finally {
      this.knowledgeLoading = false;
    }
  }

  async loadScenarioQuestion(force = false) {
    if (!this.documentId || this.scenarioLoading) return;
    if (this.scenarioQuestion && !force) return;
    this.scenarioLoading = true;

    try {
      const res = await fetch(`${this.API_BASE}/api/scenario?documentId=${this.documentId}`);
      if (!res.ok) throw new Error('Failed to load scenario.');
      const data = await res.json();
      this.scenarioQuestion = data.question;
      this.scenarioResult = undefined;
      this.scenarioDraft = '';
    } catch (err) {
      console.error(err);
    } finally {
      this.scenarioLoading = false;
    }
  }

  openScenarioModal(mode: AnswerMode) {
    if (!this.scenarioQuestion) return;
    this.scenarioMode = mode;
    this.scenarioModalOpen = true;
  }

  closeScenarioModal() {
    this.scenarioModalOpen = false;
    this.scenarioMode = 'voice';
    this.scenarioSubmitting = false;
  }

  handleVoiceAnswer(payload: { transcript: string; feedback: string; score: number }) {
    this.processScenarioResult({
      score: payload.score,
      feedback: payload.feedback,
      transcript: payload.transcript
    });
    this.closeScenarioModal();
  }

  async submitScenarioDraft() {
    const draft = this.scenarioDraft.trim();
    if (!this.documentId || !draft) return;
    this.scenarioSubmitting = true;

    try {
      const res = await fetch(`${this.API_BASE}/api/scenario/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          response: draft
        })
      });
      if (!res.ok) throw new Error('Failed to evaluate response.');
      const data = await res.json();
      this.processScenarioResult({
        score: data.score,
        feedback: data.feedback,
        transcript: draft
      });
    } catch (err: any) {
      this.errorMessage = err?.message || 'Unable to evaluate response.';
    } finally {
      this.scenarioSubmitting = false;
    }
  }

  nextAfterScenario() {
    this.unlockStep('quiz');
  }

  newScenario() {
    this.scenarioResult = undefined;
    this.scenarioDraft = '';
    this.scenarioModalOpen = false;
    this.scenarioMode = 'voice';
    this.loadScenarioQuestion(true);
  }

  private processScenarioResult(result: ScenarioResult) {
    const normalizedScore = this.extractScenarioScore(result);
    this.scenarioResult = {
      ...result,
      score: normalizedScore
    };
    this.closeScenarioModal();
    this.scenarioDraft = '';
  }

  async loadQuiz(force = false) {
    if (!this.documentId || this.quizLoading) return;
    if (this.quizQuestion && !force) return;
    this.quizLoading = true;
    this.quizResult = undefined;

    try {
      const res = await fetch(`${this.API_BASE}/api/quiz?documentId=${this.documentId}`);
      if (!res.ok) throw new Error('Failed to load quiz.');
      const data = await res.json();
      this.quizId = data.quizId;
      this.quizQuestion = data.question;
      this.quizOptions = data.options || [];
      this.quizSelection = undefined;
    } catch (err: any) {
      this.errorMessage = err?.message || 'Unable to load quiz.';
    } finally {
      this.quizLoading = false;
    }
  }

  async submitQuizAnswer(label: string) {
    if (!this.quizId) return;
    this.quizSubmitting = true;
    this.quizSelection = label;

    try {
      const res = await fetch(`${this.API_BASE}/api/quiz/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quizId: this.quizId,
          selectedOption: label
        })
      });
      if (!res.ok) throw new Error('Failed to score quiz.');
      const data = await res.json();
      this.quizResult = data;
    } catch (err: any) {
      this.errorMessage = err?.message || 'Unable to submit answer.';
    } finally {
      this.quizSubmitting = false;
    }
  }

  continueFromKnowledge() {
    this.unlockStep('scenario');
  }

  resumeExistingDocument() {
    if (!this.documentId) return;
    this.startJourney();
    this.loadKnowledgeCard();
  }

  restartJourney() {
    this.resetScenarioState();
    this.resetQuizState();
    this.visibleSteps = ['knowledge'];
    this.journeyActive = true;
    this.scrollToTop();
  }

  isStepVisible(step: ExperienceStep) {
    return this.visibleSteps.includes(step);
  }

  private startJourney() {
    this.resetScenarioState();
    this.resetQuizState();
    this.visibleSteps = ['knowledge'];
    this.journeyActive = true;
  }

  private unlockStep(step: ExperienceStep) {
    if (!this.visibleSteps.includes(step)) {
      this.visibleSteps.push(step);
      if (step === 'scenario') {
        this.loadScenarioQuestion(true);
      }
      if (step === 'quiz') {
        this.loadQuiz(true);
      }
    }
  }

  private prepareForNewDocument() {
    this.knowledgeSnippet = '';
    this.knowledgeAudio = '';
    this.resetScenarioState();
    this.resetQuizState();
    this.visibleSteps = [];
    this.journeyActive = false;
  }

  private resetScenarioState() {
    this.scenarioQuestion = '';
    this.scenarioDraft = '';
    this.scenarioResult = undefined;
    this.scenarioModalOpen = false;
    this.scenarioMode = 'voice';
  }

  private resetQuizState() {
    this.quizQuestion = '';
    this.quizOptions = [];
    this.quizResult = undefined;
    this.quizSelection = undefined;
    this.quizId = '';
  }

  private scrollToTop() {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  private extractScenarioScore(result: ScenarioResult): number {
    const rawScore = typeof result.score === 'number' ? result.score : 0;
    if (rawScore && !Number.isNaN(rawScore)) {
      return rawScore;
    }

    const feedback = result.feedback || '';

    const scoreMatch = feedback.match(/score:\s*(\d+(?:\.\d+)?)\s*(?:\/|out of)?\s*10/i);
    if (scoreMatch) {
      const parsed = Number(scoreMatch[1]);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    const percentMatch = feedback.match(/overall (?:performance )?rating:\s*(\d+(?:\.\d+)?)\s*%/i);
    if (percentMatch) {
      const percent = Number(percentMatch[1]);
      if (!Number.isNaN(percent)) {
        return percent / 10;
      }
    }

    return 0;
  }
}