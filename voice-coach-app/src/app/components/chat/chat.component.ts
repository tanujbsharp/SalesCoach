import { Component, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { VoiceModalComponent } from '../voice-modal/voice-modal.component';
import { Router } from '@angular/router';
import { DocumentStateService } from '../../services/document-state.service';

type QuizOption = { label: string; text: string };

interface QuizHistoryCard {
  question: string;
  options: QuizOption[];
  selected: string;
  correctAnswer: string;
  correct: boolean;
  explanation: string;
}

interface KnowledgeCardPayload {
  title: string;
  snippet: string;
  audioUrl?: string;
}

type ChatMessage = {
  from: 'user' | 'bot';
  text: string;
  isCard?: boolean;
  cardType?: 'quizHistory' | 'activeQuiz' | 'knowledge';
  quizHistory?: QuizHistoryCard;
  knowledgeCard?: KnowledgeCardPayload;
};

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule, VoiceModalComponent],
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css']
})
export class ChatComponent {
  @ViewChild('messagesContainer') private messagesContainer?: ElementRef<HTMLDivElement>;
  messages: ChatMessage[] = [];
  private chatHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  userText: string = '';
  showVoiceModal = false;
  showActionButtons = false;

  // Scenario modal state (reusing previous journey design)
  scenarioModalOpen = false;
  scenarioMode: 'voice' | 'text' = 'voice';
  scenarioLoading = false;
  scenarioQuestion = '';
  scenarioDraft = '';
  scenarioSubmitting = false;
  scenarioResult?: { score: number; feedback: string; transcript?: string };

  // Scenario state: when true, next user message will be scored via /api/scenario/answer.
  private awaitingScenarioAnswer = false;

  // Quiz state for inline quiz card.
  quizQuestion = '';
  quizOptions: QuizOption[] = [];
  quizId = '';
  quizSubmitting = false;
  quizSelection?: string;
  quizAnswered = false;
  quizCorrect = false;
  quizCorrectAnswer = '';
  quizExplanation = '';
  private activeQuizMessageIndex: number | null = null;
  private scrollTimeoutId: number | null = null;
  loadingOverlayVisible = false;
  loadingOverlayText = '';
  private knowledgeTopicsSeen = new Set<string>();
  private scenarioQuestionsSeen = new Set<string>();
  private quizQuestionsSeen = new Set<string>();
  isBotTyping = false;

  readonly API_BASE = 'http://127.0.0.1:8000';

  constructor(private router: Router, private documentState: DocumentStateService) {
    const docId = this.documentId;
    if (!docId) {
      this.router.navigate(['/']);
      return;
    }
    this.seedInitialMessages();
  }

  private get documentId() {
    return this.documentState.getDocumentId();
  }

  private async seedInitialMessages() {
    const greeting = "Hi, I'm your sales coach. How can I assist you today?";
    this.addBotMessage(greeting, greeting);

    if (!this.documentId) {
      return;
    }

    try {
      const res = await fetch(`${this.API_BASE}/api/topic?documentId=${this.documentId}`);
      const data = await res.json();
      const topic = (data.topic as string) || 'this product';
      const html = `Your document is about <strong>${topic}</strong>. Do you have any prior experience with this area?`;
      const plain = `Your document is about ${topic}. Do you have any prior experience with this area?`;
      this.addBotMessage(html, plain);
    } catch (err) {
      console.error('Failed to load topic:', err);
    }

    this.showActionButtons = true;
  }

  async submitText() {
    const trimmed = this.userText.trim();
    if (!trimmed) return;

    if (!this.documentId) {
      this.addBotMessage('Please upload a document first on the home page.');
      this.userText = '';
      return;
    }

    const input = trimmed;
    const censored = this.containsAbuse(input) ? '****' : input;
    this.addUserMessage(censored, input);
    this.userText = '';

    if (this.awaitingScenarioAnswer) {
      await this.submitScenarioAnswer(input);
      this.awaitingScenarioAnswer = false;
      return;
    }

    await this.sendChatToBackend();
  }

  handleVoiceResponse(e: { transcript: string; feedback: string; score: number }) {
    const input = e.transcript || '[voice input]';
    const censored = this.containsAbuse(input) ? '****' : input;

    this.addUserMessage(censored, input);
    // For now, treat voice responses as regular chat turns.
    this.sendChatToBackend();
  }

  private addBotMessage(html: string, plainText?: string, isCard = false) {
    this.messages.push({ from: 'bot', text: html, isCard });
    if (plainText) {
      this.chatHistory.push({ role: 'assistant', content: plainText });
    }
    this.scheduleScrollToBottom();
  }

  private addUserMessage(displayText: string, plainText: string) {
    this.messages.push({ from: 'user', text: displayText });
    this.chatHistory.push({ role: 'user', content: plainText });
    this.scheduleScrollToBottom();
  }

  private async sendChatToBackend() {
    if (!this.documentId) return;
    this.isBotTyping = true;
    try {
      const res = await fetch(`${this.API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          messages: this.chatHistory
        })
      });
      const data = await res.json();
      const reply: string = (data.reply as string) || 'Sorry, I had trouble responding.';
      const html = reply.replace(/\n/g, '<br>');
      this.addBotMessage(html, reply);
    } catch (err) {
      console.error('Chat error:', err);
      this.addBotMessage('Sorry, there was an error responding. Please try again.');
    } finally {
      this.isBotTyping = false;
    }
  }

  // Quick action buttons
  async triggerKnowledgeCard() {
    if (!this.documentId) return;
    this.showLoadingOverlay('Preparing a knowledge card for you...');
    try {
      const maxAttempts = 5;
      let card: KnowledgeCardPayload | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(`${this.API_BASE}/api/knowledge-card?documentId=${this.documentId}`);
        const data = await res.json();
        const audioUrl = data.audioUrl ? `${this.API_BASE}/${data.audioUrl}` : '';
        const title = (data.title as string) || 'Knowledge card';
        const snippet: string = data.snippet || '';
        const topicKey = this.normalizeKey(title || snippet);
        if (!topicKey) continue;
        if (this.knowledgeTopicsSeen.has(topicKey)) {
          continue;
        }
        this.knowledgeTopicsSeen.add(topicKey);
        card = {
          title,
          snippet,
          audioUrl
        };
        break;
      }

      if (!card) {
        this.addBotMessage('Looks like we have already explored those knowledge topics. Try again later for new content.');
        return;
      }

      this.addKnowledgeCard(card);
      this.chatHistory.push({ role: 'assistant', content: `Knowledge card: ${card.snippet}` });
    } catch (err) {
      console.error('Knowledge card error:', err);
      this.addBotMessage('Sorry, I could not load the knowledge card.');
    } finally {
      this.hideLoadingOverlay();
    }
  }

  async triggerScenarioCard() {
    if (!this.documentId) return;
    this.showLoadingOverlay('Loading a scenario for you...');
    await this.loadScenarioQuestion(true);
    this.hideLoadingOverlay();
    if (this.scenarioQuestion) {
      this.openScenarioModal('voice');
    }
  }

  private async submitScenarioAnswer(answer: string) {
    if (!this.documentId) return;
    try {
      const res = await fetch(`${this.API_BASE}/api/scenario/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          response: answer
        })
      });
      const data = await res.json();
      const html = `
        <div><strong>Scenario Feedback</strong></div>
        <div>${data.feedback}</div>
      `;
      this.addBotMessage(html, `Scenario feedback. Score: ${data.score}`);
    } catch (err) {
      console.error('Scenario answer error:', err);
      this.addBotMessage('Sorry, there was a problem scoring your scenario answer.');
    }
  }

  async triggerQuizCard() {
    if (!this.documentId) return;
    this.showLoadingOverlay('Loading a quiz question...');

    // If a quiz is currently on-screen and has been answered, archive it into the chat history.
    if (this.quizQuestion && this.quizOptions.length) {
      const card = this.createQuizHistoryCard();
      const placeholderIndex = this.removeActiveQuizMessage();
      if (card && this.quizAnswered) {
        this.addQuizHistoryCard(card, placeholderIndex ?? undefined);
      }
      this.resetQuizState();
    }

    try {
      const maxAttempts = 5;
      let quizData: any | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(`${this.API_BASE}/api/quiz?documentId=${this.documentId}`);
        const data = await res.json();
        const key = this.normalizeKey(data?.quizId || data?.question);
        if (!key) continue;
        if (this.quizQuestionsSeen.has(key)) {
          continue;
        }
        this.quizQuestionsSeen.add(key);
        quizData = data;
        break;
      }

      if (!quizData) {
        this.addBotMessage('We have already covered those quiz questions. Please try again later for fresh ones.');
        return;
      }

      this.quizId = quizData.quizId;
      this.quizQuestion = quizData.question;
      this.quizOptions = quizData.options || [];
      this.quizSelection = undefined;
      this.quizAnswered = false;
      this.quizCorrect = false;
      this.quizCorrectAnswer = '';
      this.quizExplanation = '';
      this.attachActiveQuizMessage();
    } catch (err) {
      console.error('Quiz error:', err);
      this.addBotMessage('Sorry, I could not load a quiz question.');
    } finally {
      this.hideLoadingOverlay();
    }
  }

  async submitQuizOption(label: string) {
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
      const data = await res.json();
      this.quizAnswered = true;
      this.quizCorrect = !!data.correct;
      this.quizCorrectAnswer = data.answer;
      this.quizExplanation = data.explanation || '';
    } catch (err) {
      console.error('Quiz answer error:', err);
      this.addBotMessage('Sorry, there was a problem scoring your quiz answer.');
    } finally {
      this.quizSubmitting = false;
    }
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

  private createQuizHistoryCard(): QuizHistoryCard | null {
    if (!this.quizQuestion || !this.quizOptions.length || !this.quizSelection) {
      return null;
    }
    return {
      question: this.quizQuestion,
      options: this.quizOptions.map(option => ({ ...option })),
      selected: this.quizSelection,
      correctAnswer: this.quizCorrectAnswer,
      correct: this.quizCorrect,
      explanation: this.quizExplanation
    };
  }

  private addQuizHistoryCard(card: QuizHistoryCard, insertIndex?: number) {
    const message: ChatMessage = {
      from: 'bot',
      text: '',
      isCard: true,
      cardType: 'quizHistory',
      quizHistory: card
    };
    if (typeof insertIndex === 'number') {
      this.messages.splice(insertIndex, 0, message);
    } else {
      this.messages.push(message);
    }
    this.chatHistory.push({
      role: 'assistant',
      content: `Quiz result for "${card.question}": ${card.correct ? 'correct' : 'incorrect'}.`
    });
    this.scheduleScrollToBottom();
  }

  private resetQuizState() {
    this.quizQuestion = '';
    this.quizOptions = [];
    this.quizId = '';
    this.quizSelection = undefined;
    this.quizAnswered = false;
    this.quizCorrect = false;
    this.quizCorrectAnswer = '';
    this.quizExplanation = '';
  }

  private attachActiveQuizMessage() {
    if (this.activeQuizMessageIndex !== null || !this.quizQuestion) {
      return;
    }
    const message: ChatMessage = {
      from: 'bot',
      text: '',
      isCard: true,
      cardType: 'activeQuiz'
    };
    this.messages.push(message);
    this.activeQuizMessageIndex = this.messages.length - 1;
    this.scheduleScrollToBottom();
  }

  private removeActiveQuizMessage(): number | null {
    if (this.activeQuizMessageIndex === null) {
      return null;
    }
    const index = this.activeQuizMessageIndex;
    this.messages.splice(index, 1);
    this.activeQuizMessageIndex = null;
    return index;
  }

  private scheduleScrollToBottom() {
    if (this.scrollTimeoutId !== null) {
      window.clearTimeout(this.scrollTimeoutId);
    }
    this.scrollTimeoutId = window.setTimeout(() => {
      this.scrollTimeoutId = null;
      this.scrollToBottom();
    }, 0);
  }

  private scrollToBottom() {
    const container = this.messagesContainer?.nativeElement;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth'
    });
  }

  private addKnowledgeCard(card: KnowledgeCardPayload) {
    const message: ChatMessage = {
      from: 'bot',
      text: '',
      isCard: true,
      cardType: 'knowledge',
      knowledgeCard: card
    };
    this.messages.push(message);
    this.scheduleScrollToBottom();
  }

  // Scenario modal helpers
  private async loadScenarioQuestion(force = false) {
    if (!this.documentId || this.scenarioLoading) return;
    if (this.scenarioQuestion && !force) return;
    if (force) {
      this.scenarioQuestion = '';
    }
    this.scenarioLoading = true;

    try {
      const maxAttempts = 5;
      let nextQuestion = '';

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(`${this.API_BASE}/api/scenario?documentId=${this.documentId}`);
        const data = await res.json();
        const question = (data.question as string) || '';
        const questionKey = this.normalizeKey(question);
        if (!questionKey) continue;
        if (this.scenarioQuestionsSeen.has(questionKey)) {
          continue;
        }
        this.scenarioQuestionsSeen.add(questionKey);
        nextQuestion = question;
        break;
      }

      if (nextQuestion) {
        this.scenarioQuestion = nextQuestion;
        this.scenarioResult = undefined;
        this.scenarioDraft = '';
      } else {
        this.addBotMessage('I could not find a brand-new scenario right now. Please try again later.');
      }
    } catch (err) {
      console.error('Scenario error:', err);
      this.addBotMessage('Sorry, I could not load a scenario right now.');
    } finally {
      this.scenarioLoading = false;
    }
  }

  openScenarioModal(mode: 'voice' | 'text') {
    if (!this.scenarioQuestion) return;
    this.scenarioMode = mode;
    this.scenarioModalOpen = true;
  }

  closeScenarioModal() {
    this.scenarioModalOpen = false;
    this.scenarioMode = 'voice';
    this.scenarioSubmitting = false;
  }

  handleScenarioVoiceAnswer(e: { transcript: string; feedback: string; score: number }) {
    this.processScenarioResult({
      score: e.score,
      feedback: e.feedback,
      transcript: e.transcript
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
      const data = await res.json();
      this.processScenarioResult({
        score: data.score,
        feedback: data.feedback,
        transcript: draft
      });
    } catch (err) {
      console.error('Scenario answer error:', err);
      this.addBotMessage('Sorry, there was a problem scoring your scenario answer.');
    } finally {
      this.scenarioSubmitting = false;
    }
  }

  private processScenarioResult(result: { score: number; feedback: string; transcript?: string }) {
    this.scenarioResult = result;

    if (result.transcript) {
      const transcriptHtml = `
        <div class="scenario-response-inline">
          <p class="scenario-response-title">Your response</p>
          <p class="scenario-response-body">${this.escapeHtml(result.transcript).replace(/\n/g, '<br>')}</p>
        </div>
      `;
      this.pushScenarioBubble('user', transcriptHtml);
    }

    const scoreText = Number(result.score ?? 0).toFixed(1);
    const feedbackHtml = `
      <div class="scenario-feedback-inline">
        <p class="scenario-feedback-title">Scenario feedback</p>
        <p class="scenario-feedback-score">${scoreText} / 10 overall</p>
        <div class="scenario-feedback-body">${result.feedback}</div>
      </div>
    `;
    this.pushScenarioBubble('bot', feedbackHtml);
    this.chatHistory.push({
      role: 'assistant',
      content: `Scenario feedback. Score: ${result.score}`
    });
  }

  private pushScenarioBubble(from: 'user' | 'bot', html: string) {
    this.messages.push({ from, text: html });
    this.scheduleScrollToBottom();
  }

  private escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private showLoadingOverlay(text: string) {
    this.loadingOverlayText = text;
    this.loadingOverlayVisible = true;
  }

  private hideLoadingOverlay() {
    this.loadingOverlayVisible = false;
    this.loadingOverlayText = '';
  }

  private normalizeKey(value?: string) {
    return (value || '').trim().toLowerCase();
  }
}