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
  audioId?: string;
}

interface ScenarioCardPayload {
  id: string;
  question: string;
  summary?: string;
  preference: ScenarioPreference;
  filters?: ScenarioFlowData;
}

interface ScenarioRemediationState {
  topic: string;
  totalQuizzes: number;
  quizzesAsked: number;
  quizzesCorrect: number;
  preference: ScenarioPreference;
  filters?: ScenarioFlowData;
  scenarioCard?: ScenarioCardPayload;
}

interface QuizChallengeState {
  targetCorrect: number;
  correct: number;
  attempted: number;
  topic?: string;
}

type ChatMessage = {
  from: 'user' | 'bot';
  text: string;
  isCard?: boolean;
  cardType?: 'quizHistory' | 'activeQuiz' | 'knowledge' | 'scenario';
  quizHistory?: QuizHistoryCard;
  knowledgeCard?: KnowledgeCardPayload;
  scenarioCard?: ScenarioCardPayload;
};

type KnowledgePreference = 'pathway' | 'topic';
type ScenarioPreference = 'classic' | 'tailored';
type QuizPreference = 'arbitrary' | 'topic';

interface LearnerProfile {
  strengths: string[];
  weaknesses: string[];
  knowledgeGaps: string[];
  notes: string[];
}

interface ScenarioFlowData {
  intent?: string;
  industry?: string;
  situation?: string;
  objection?: string;
  audience?: string;
  summary?: string;
}

type GuidedFlow = {
  type: 'scenario';
  step: 'preference' | 'details';
  preference?: ScenarioPreference;
  data: ScenarioFlowData;
};
type ScenarioGuidedFlow = GuidedFlow;

type ContentCommand =
  | { kind: 'knowledge'; topic?: string }
  | { kind: 'quiz'; topic?: string }
  | { kind: 'scenario'; preference: ScenarioPreference; useOutline?: boolean }
  | { kind: 'repeat'; target?: 'knowledge' | 'quiz' | 'scenario' };

interface SuggestionPrompt {
  cardType: 'knowledge' | 'quiz' | 'scenario';
  reason: 'learning' | 'weakness';
  topic?: string;
  variant?: 'summary' | 'default';
}

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
  private knowledgeAudioState: Record<
    string,
    { playing: boolean; current: number; duration: number; volume: number; speed: number }
  > = {};
  knowledgeSpeedOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  knowledgeMenuOpenId?: string;
  learnerProfile: LearnerProfile = { strengths: [], weaknesses: [], knowledgeGaps: [], notes: [] };
  private pendingFlow: GuidedFlow | null = null;
  private currentQuizTopic?: string;
  private lastScenarioFilters?: ScenarioFlowData;
  private lastContentRequest?: { type: 'knowledge' | 'quiz' | 'scenario'; preference?: string; topic?: string };
  private knowledgeChain = 0;
  private quizChain = 0;
  private cardsSincePrompt = 0;
  private pendingSuggestion?: SuggestionPrompt | null = null;
  private lastSuggestionTimestamp = 0;
  private readonly suggestionCooldownMs = 45000;
  private lastKnowledgeFocus?: string;
  private lastAssistantPlainText?: string;
  private documentTopic?: string;
  private lastQuizTopic?: string;
  private lastEngagementNudge = 0;
  private readonly engagementCooldownMs = 20000;
  private onboardingKnowledgeCardServed = false;
  private lastScenarioCard?: ScenarioCardPayload;
  private scenarioRetryAttempts = 0;
  private readonly scenarioMasteryScore = 7.5;
  private scenarioRemediation?: ScenarioRemediationState;
  private quizChallenge?: QuizChallengeState;
  private lastScenarioOutline?: string;
  private lastScenarioOutlineTimestamp = 0;
  private readonly scenarioOutlineTtlMs = 5 * 60 * 1000;
  private awaitingTableFormat = false;
  starterOptionsVisible = false;

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
      this.documentTopic = topic;
      const html = `Your document is about <strong>${topic}</strong>. Do you have any prior experience with this area?`;
      const plain = `Your document is about ${topic}. Do you have any prior experience with this area?`;
      this.addBotMessage(html, plain);
      this.showStarterOptions();
    } catch (err) {
      console.error('Failed to load topic:', err);
    }

    this.showActionButtons = true;
  }

  private showStarterOptions() {
    if (this.messages.length > 0) {
      this.starterOptionsVisible = true;
    }
  }

  private hideStarterOptions() {
    this.starterOptionsVisible = false;
  }

  async handleStarterOption(kind: 'knowledge' | 'scenario' | 'quiz') {
    if (!this.documentId) {
      this.addBotMessage('Please upload a document first on the home page.');
      return;
    }
    this.hideStarterOptions();
    if (kind === 'knowledge') {
      this.sendKnowledgePrimer(this.documentTopic);
      await this.requestKnowledgeCard('pathway');
      return;
    }
    if (kind === 'scenario') {
      this.triggerScenarioCard();
      return;
    }
    this.startQuizChallenge();
  }

  private async startQuizChallenge() {
    const topic = this.lastKnowledgeFocus || this.documentTopic || undefined;
    this.quizChallenge = {
      targetCorrect: 5,
      correct: 0,
      attempted: 0,
      topic
    };
    this.addBotMessage(
      "Challenge accepted! I'll keep firing quiz cards until you get 5 correct answers. Let me know if you want to stop."
    );
    await this.launchQuizChallengeQuestion();
  }

  private detectTableRequest(input: string) {
    const normalized = input.toLowerCase();
    const tableKeywords = ['table', 'tabular', 'grid', 'matrix', 'chart'];
    return tableKeywords.some(keyword => this.containsWord(normalized, keyword));
  }

  private formatReplyAsTable(raw: string) {
    if (!raw) return '';
    const markdown = this.extractMarkdownTable(raw);
    if (markdown.length) {
      return this.renderMarkdownTable(markdown);
    }
    const entries = this.extractTableEntries(raw);
    if (entries.length >= 2) {
      return this.renderTable(entries);
    }
    return raw.replace(/\n/g, '<br>');
  }

  private extractTableEntries(raw: string) {
    const lines = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const entries: { key: string; value: string }[] = [];
    lines.forEach((line, idx) => {
      const bulletStripped = line.replace(/^[-*•]\s*/, '');
      const colonMatch = bulletStripped.match(/^([^:]+):\s*(.+)$/);
      if (colonMatch) {
        entries.push({ key: colonMatch[1].trim(), value: colonMatch[2].trim() });
        return;
      }
      if (/^[-*•]/.test(line)) {
        entries.push({ key: `Item ${idx + 1}`, value: bulletStripped });
      }
    });
    return entries;
  }

  private renderTable(entries: { key: string; value: string }[]) {
    let html = '<table class="chat-table">';
    html += '<thead><tr><th>Detail</th><th>Information</th></tr></thead>';
    html +=
      '<tbody>' +
      entries
        .map(entry => `<tr><td>${this.escapeHtml(entry.key)}</td><td>${this.escapeHtml(entry.value)}</td></tr>`)
        .join('') +
      '</tbody>';
    html += '</table>';
    return html;
  }

  private extractMarkdownTable(raw: string) {
    const lines = raw.split('\n');
    const tableLines: string[] = [];
    let capturing = false;
    lines.forEach(line => {
      if (line.trim().startsWith('|')) {
        capturing = true;
        tableLines.push(line.trim());
      } else if (capturing) {
        capturing = false;
      }
    });
    if (tableLines.length >= 2) {
      return tableLines;
    }
    return [];
  }

  private renderMarkdownTable(lines: string[]) {
    const rows = lines
      .map(line =>
        line
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map(cell => cell.trim())
      )
      .filter(row => row.length);
    if (!rows.length) {
      return lines.join('<br>');
    }
    const header = rows.shift()!;
    if (rows.length && rows[0].every(cell => /^:?-{3,}:?$/.test(cell))) {
      rows.shift();
    }
    const columnCount = Math.max(header.length, ...rows.map(row => row.length));
    const normalizeRow = (row: string[]) =>
      Array.from({ length: columnCount }, (_, idx) => this.escapeHtml(row[idx] || ''));
    let html = '<table class="chat-table">';
    html +=
      '<thead><tr>' +
      normalizeRow(header)
        .map(cell => `<th>${cell}</th>`)
        .join('') +
      '</tr></thead>';
    html +=
      '<tbody>' +
      (rows.length ? rows : [header])
        .map(row => '<tr>' + normalizeRow(row).map(cell => `<td>${cell}</td>`).join('') + '</tr>')
        .join('') +
      '</tbody>';
    html += '</table>';
    return html;
  }

  private captureScenarioOutline(text: string) {
    if (!text) return;
    const normalized = text.toLowerCase();
    const triggers = ['scenario:', 'your task', 'respond to the customer', 'practice scenario', 'this scenario challenges you'];
    if (triggers.some(trigger => normalized.includes(trigger))) {
      this.lastScenarioOutline = text;
      this.lastScenarioOutlineTimestamp = Date.now();
    }
  }

  private hasFreshScenarioOutline() {
    return !!this.getFreshScenarioOutline();
  }

  private getFreshScenarioOutline() {
    if (!this.lastScenarioOutline) return undefined;
    if (Date.now() - this.lastScenarioOutlineTimestamp > this.scenarioOutlineTtlMs) {
      this.lastScenarioOutline = undefined;
      return undefined;
    }
    return this.lastScenarioOutline;
  }

  private async launchQuizChallengeQuestion() {
    const plan = this.quizChallenge;
    if (!plan) return;
    const topic = plan.topic || this.documentTopic;
    await this.requestQuiz(topic ? 'topic' : 'arbitrary', topic);
  }

  async submitText() {
    const trimmed = this.userText.trim();
    if (!trimmed) return;

    this.hideStarterOptions();
    this.awaitingTableFormat = this.detectTableRequest(trimmed);

    if (!this.documentId) {
      this.addBotMessage('Please upload a document first on the home page.');
      this.userText = '';
      return;
    }

    const input = trimmed;
    const censored = this.containsAbuse(input) ? '****' : input;
    this.addUserMessage(censored, input);
    this.userText = '';
    this.captureLearnerNote(input);

    if (this.pendingFlow) {
      await this.handlePendingFlowInput(input);
      return;
    }

    if (await this.handleSuggestionResponse(input)) {
      return;
    }

    if (this.shouldAutoServeOnboardingKnowledge(input)) {
      this.onboardingKnowledgeCardServed = true;
      this.sendKnowledgePrimer(this.documentTopic);
      await this.requestKnowledgeCard('pathway');
      return;
    }

    if (this.shouldAutoServeOnboardingKnowledge(input)) {
      this.onboardingKnowledgeCardServed = true;
      this.sendKnowledgePrimer(this.documentTopic);
      await this.requestKnowledgeCard('pathway');
      return;
    }

    const command = this.detectContentCommand(input);
    if (command) {
      await this.executeContentCommand(command);
      return;
    }

    if (this.awaitingScenarioAnswer) {
      await this.submitScenarioAnswer(input);
      this.awaitingScenarioAnswer = false;
      return;
    }

    await this.sendChatToBackend();
  }

  async handleVoiceResponse(e: { transcript: string; feedback: string; score: number }) {
    const input = e.transcript || '[voice input]';
    const censored = this.containsAbuse(input) ? '****' : input;

    this.hideStarterOptions();
    this.awaitingTableFormat = this.detectTableRequest(input);

    this.addUserMessage(censored, input);
    this.captureLearnerNote(input);
    if (this.pendingFlow) {
      await this.handlePendingFlowInput(input);
      return;
    }
    if (await this.handleSuggestionResponse(input)) {
      return;
    }
    const command = this.detectContentCommand(input);
    if (command) {
      await this.executeContentCommand(command);
      return;
    }
    // For now, treat voice responses as regular chat turns.
    await this.sendChatToBackend();
  }

  private addBotMessage(html: string, plainText?: string, isCard = false) {
    this.messages.push({ from: 'bot', text: html, isCard });
    if (plainText) {
      this.chatHistory.push({ role: 'assistant', content: plainText });
      this.lastAssistantPlainText = plainText;
      this.captureScenarioOutline(plainText);
    } else {
      const fallbackPlain = this.stripHtml(html);
      if (fallbackPlain) {
        this.lastAssistantPlainText = fallbackPlain;
        this.chatHistory.push({ role: 'assistant', content: fallbackPlain });
        this.captureScenarioOutline(fallbackPlain);
      }
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
    this.hideStarterOptions();
    this.isBotTyping = true;
    try {
      const learnerProfile = this.getLearnerProfileSnapshot();
      const res = await fetch(`${this.API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          messages: this.chatHistory,
          learnerProfile
        })
      });
      const data = await res.json();
      const reply: string = (data.reply as string) || 'Sorry, I had trouble responding.';
      const html = this.awaitingTableFormat ? this.formatReplyAsTable(reply) : reply.replace(/\n/g, '<br>');
      this.awaitingTableFormat = false;
      this.addBotMessage(html, reply);
    } catch (err) {
      console.error('Chat error:', err);
      this.addBotMessage('Sorry, there was an error responding. Please try again.');
    } finally {
      this.isBotTyping = false;
    }
  }

  // Quick action buttons
  triggerKnowledgeCard() {
    this.hideStarterOptions();
    if (!this.documentId) return;
    this.requestKnowledgeCard('pathway');
  }

  triggerScenarioCard() {
    this.hideStarterOptions();
    if (!this.documentId) return;
    if (this.pendingFlow) {
      this.addBotMessage("I'm already working through another request—let's wrap that before starting a new scenario.");
      return;
    }
    this.pendingFlow = { type: 'scenario', step: 'preference', data: {} };
    const prompt =
      'Want a classic practice scenario or should I craft something tailored? Reply with "classic" or drop your custom scenario now—mention the customer situation, industry, audience, and intent so I can spin it up immediately.';
    this.addBotMessage(prompt);
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

  triggerQuizCard() {
    this.hideStarterOptions();
    if (!this.documentId) return;
    this.requestQuiz('arbitrary');
  }

  private async handlePendingFlowInput(rawInput: string) {
    const flow = this.pendingFlow;
    if (!flow) {
      return;
    }
    const input = rawInput.trim();
    if (!input) {
      this.addBotMessage('Give me a bit more detail so I can keep tailoring things for you.');
      return;
    }
    const lowered = input.toLowerCase();
    if (lowered === 'cancel') {
      this.pendingFlow = null;
      this.addBotMessage('No worries—we can pick that up later. Just tap the card again when you are ready.');
      return;
    }

    await this.resolveScenarioFlow(input, flow as ScenarioGuidedFlow);
  }

  private async resolveScenarioFlow(input: string, flow: ScenarioGuidedFlow) {
    if (flow.step === 'preference') {
      const lowered = input.toLowerCase();
      const wantsClassic = lowered.includes('classic') || lowered.includes('basic') || lowered.includes('standard');
      if (wantsClassic) {
        this.pendingFlow = null;
        await this.requestScenario('classic');
        return;
      }
      const hasScenarioDescription = this.isScenarioDescription(input);
      if (hasScenarioDescription) {
        const parsed = this.parseScenarioDetails(input);
        this.pendingFlow = null;
        await this.requestScenario('tailored', parsed, parsed.summary);
        return;
      }
      flow.preference = 'tailored';
      flow.step = 'details';
      this.addBotMessage(
        'Great—describe the scenario in one message. Mention the customer situation, industry, target audience, and intent if you can.'
      );
      return;
    }

    if (flow.step === 'details') {
      const parsed = this.parseScenarioDetails(input);
      flow.data = { ...flow.data, ...parsed };
      this.pendingFlow = null;
      await this.requestScenario('tailored', { ...flow.data }, parsed.summary);
    }
  }

  private parseScenarioDetails(input: string): ScenarioFlowData {
    const summary = input.trim();
    const parsed: ScenarioFlowData = { summary };
    const lowered = summary.toLowerCase();

    const keywordMap: Record<
      keyof ScenarioFlowData,
      { patterns: string[]; heuristics?: { keyword: string; value: string }[] }
    > = {
      intent: { patterns: ['intent', 'goal', 'objective', 'purpose', 'intent is'] },
      industry: {
        patterns: ['industry', 'sector', 'market'],
        heuristics: [
          { keyword: 'tech', value: 'technology' },
          { keyword: 'saas', value: 'software' },
          { keyword: 'health', value: 'healthcare' },
          { keyword: 'finance', value: 'financial services' },
          { keyword: 'retail', value: 'retail' }
        ]
      },
      situation: { patterns: ['situation', 'context', 'trigger', 'problem', 'issue'] },
      objection: { patterns: ['objection', 'concern', 'pushback', 'hesitation'] },
      audience: { patterns: ['audience', 'persona', 'buyer', 'customer', 'stakeholder'] },
      summary: { patterns: [] }
    };

    const extractByPatterns = (patterns: string[]) => {
      for (const pattern of patterns) {
        const regex = new RegExp(`${pattern}\\s*(?:[:=]|is|are)?\\s*([^.;\\n]+)`, 'i');
        const match = summary.match(regex);
        if (match) {
          return match[1].trim();
        }
      }
      return undefined;
    };

    (Object.keys(keywordMap) as (keyof ScenarioFlowData)[]).forEach(key => {
      if (key === 'summary') return;
      const currentValue = extractByPatterns(keywordMap[key].patterns);
      if (currentValue) {
        parsed[key] = currentValue;
        return;
      }
      const heuristics = keywordMap[key].heuristics || [];
      for (const hint of heuristics) {
        if (lowered.includes(hint.keyword)) {
          parsed[key] = hint.value;
          break;
        }
      }
    });

    return parsed;
  }

  private isScenarioDescription(input: string) {
    const trimmed = input.trim();
    if (!trimmed) return false;
    const normalized = trimmed.toLowerCase();
    if (normalized.includes('classic scenario')) return false;
    const keywords = ['customer', 'client', 'prospect', 'industry', 'audience', 'intent', 'situation', 'objection'];
    const hasKeyword = keywords.some(keyword => this.containsWord(normalized, keyword));
    const wordCount = trimmed.split(/\s+/).length;
    return hasKeyword || wordCount >= 10;
  }

  private sendKnowledgePrimer(topic?: string) {
    const primer = this.buildKnowledgePrimerContent(topic);
    this.addBotMessage(primer.html, primer.plain);
  }

  private buildKnowledgePrimerContent(topic?: string) {
    const focus = topic || this.lastKnowledgeFocus || this.documentTopic || 'this document';
    const focusLabel = this.formatTopicLabel(focus);
    const html = `
      <div class="knowledge-primer">
        <h3>Core concepts: ${this.escapeHtml(focusLabel)}</h3>
        <p class="knowledge-primer-intro">Here’s the cheat sheet before you dive deeper.</p>

        <section>
          <h4>Key pillars</h4>
          <ul>
            <li><strong>Context:</strong> Summarize why ${this.escapeHtml(focusLabel)} matters to the buyer right now.</li>
            <li><strong>Value hook:</strong> Tie the benefit to a measurable outcome (time saved, revenue won, risk reduced).</li>
            <li><strong>Proof:</strong> Quote a customer stat, success metric, or specification that validates the claim.</li>
          </ul>
        </section>

        <section>
          <h4>Conversation beats</h4>
          <ul>
            <li><strong>Open:</strong> Mirror their current challenge and link it to ${this.escapeHtml(focusLabel)}.</li>
            <li><strong>Guide:</strong> Walk through the improvement in two or three crisp steps.</li>
            <li><strong>Close:</strong> Ask for a next step that keeps momentum (demo, pilot, follow-up).</li>
          </ul>
        </section>

        <section>
          <h4>Knowledge boost</h4>
          <p>I’m sharing a supporting knowledge card on ${this.escapeHtml(
            focusLabel
          )} right after this so you can skim the essentials.</p>
        </section>
      </div>
    `;
    const plain = `Core concepts for ${focusLabel}: frame the customer context, link ${focusLabel} to outcomes with proof, and map a clear open-guide-close talk track. Knowledge card on ${focusLabel} is on the way.`;
    return { html, plain };
  }

  private async requestKnowledgeCard(preference: KnowledgePreference, topic?: string) {
    if (!this.documentId) return;
    this.showLoadingOverlay('Preparing a knowledge card for you...');
    try {
      const res = await fetch(`${this.API_BASE}/api/knowledge-card`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          preference,
          topic,
          learnerProfile: this.getLearnerProfileSnapshot()
        })
      });
      if (!res.ok) {
        throw new Error(`Knowledge card request failed (${res.status})`);
      }
        const data = await res.json();
      const audioPath: string = data.audioUrl || '';
      const audioUrl = audioPath
        ? audioPath.startsWith('http')
          ? audioPath
          : `${this.API_BASE}/${audioPath.replace(/^\/+/, '')}`
        : '';
        const title = (data.title as string) || 'Knowledge card';
        const snippet: string = data.snippet || '';
        const topicKey = this.normalizeKey(title || snippet);
      if (preference === 'pathway' && topicKey) {
        if (this.knowledgeTopicsSeen.has(topicKey)) {
          this.addBotMessage('Looks like we just reviewed that concept. Ask for a specific topic if you want a deeper dive.');
          return;
        }
        this.knowledgeTopicsSeen.add(topicKey);
      }

      const card: KnowledgeCardPayload = {
        title,
        snippet,
        audioUrl
      };
      card.audioId = this.generateId('knowledge-audio');
      this.addKnowledgeCard(card);
      this.chatHistory.push({ role: 'assistant', content: `Knowledge card: ${card.snippet}` });
      const inferredTopic = this.pickKnowledgeFocus(topic, data?.topic, title, this.extractKeywordsFromSnippet(snippet));
      this.lastKnowledgeFocus = inferredTopic || this.lastKnowledgeFocus;
      this.setLastContentRequest({ type: 'knowledge', preference, topic: this.lastKnowledgeFocus });
      this.knowledgeChain += 1;
      this.quizChain = 0;
      this.cardsSincePrompt += 1;
      this.maybeOfferLearningRecommendation(topic);
      this.scheduleEngagementNudge('knowledge', this.lastKnowledgeFocus);
    } catch (err) {
      console.error('Knowledge card error:', err);
      this.addBotMessage('Sorry, I could not load the knowledge card.');
    } finally {
      this.hideLoadingOverlay();
    }
  }

  private async requestScenario(preference: ScenarioPreference, filters?: ScenarioFlowData, description?: string) {
    if (!this.documentId) return;
    this.showLoadingOverlay('Shaping a practice scenario...');
    try {
      const descriptionPayload = description ?? filters?.summary;
      const res = await fetch(`${this.API_BASE}/api/scenario`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: this.documentId,
          preference,
          filters,
          description: descriptionPayload,
          learnerProfile: this.getLearnerProfileSnapshot()
        })
      });
      if (!res.ok) {
        throw new Error(`Scenario request failed (${res.status})`);
      }
      const data = await res.json();
      const question = (data.question as string) || '';
      if (!question) {
        this.addBotMessage('I had trouble crafting a fresh scenario. Try again in a moment.');
        return;
      }
      this.lastScenarioFilters = filters ? { ...filters } : undefined;
      this.scenarioQuestion = question;
      this.scenarioResult = undefined;
      this.scenarioDraft = '';
      const key = this.normalizeKey(question);
      if (key) {
        this.scenarioQuestionsSeen.add(key);
      }
      const summary = this.describeScenarioSummary(filters, descriptionPayload, question);
      const card: ScenarioCardPayload = {
        id: this.generateId('scenario-card'),
        question,
        summary,
        preference,
        filters: filters ? { ...filters } : undefined
      };
      this.addScenarioCard(card);
      this.addBotMessage("Here's a scenario card to keep practicing—open it whenever you're ready.");
      const scenarioTopic = description || filters?.intent || filters?.summary || question;
      this.setLastContentRequest({ type: 'scenario', preference, topic: scenarioTopic });
      this.knowledgeChain = 0;
      this.quizChain = 0;
      this.cardsSincePrompt += 1;
      this.scenarioRetryAttempts = 0;
    } catch (err) {
      console.error('Scenario error:', err);
      this.addBotMessage('Sorry, I could not load a scenario right now.');
    } finally {
      this.hideLoadingOverlay();
    }
  }

  private describeScenarioSummary(filters?: ScenarioFlowData, description?: string, fallback?: string) {
    return (
      description ||
      filters?.intent ||
      filters?.situation ||
      filters?.summary ||
      filters?.audience ||
      fallback ||
      this.documentTopic
    );
  }

  private addScenarioCard(card: ScenarioCardPayload) {
    const message: ChatMessage = {
      from: 'bot',
      text: '',
      isCard: true,
      cardType: 'scenario',
      scenarioCard: {
        ...card,
        filters: card.filters ? { ...card.filters } : undefined
      }
    };
    this.messages.push(message);
    if (message.scenarioCard) {
      this.lastScenarioCard = {
        ...message.scenarioCard,
        filters: message.scenarioCard.filters ? { ...message.scenarioCard.filters } : undefined
      };
    }
    const context = card.summary || card.question;
    this.chatHistory.push({
      role: 'assistant',
      content: `Scenario card queued: ${context}`
    });
    this.lastAssistantPlainText = `Scenario card: ${context}`;
    this.scheduleScrollToBottom();
  }

  startScenarioFromCard(card: ScenarioCardPayload, mode: 'voice' | 'text') {
    if (!card?.question) return;
    this.scenarioQuestion = card.question;
    this.scenarioResult = undefined;
    this.scenarioDraft = '';
    if (card.filters) {
      this.lastScenarioFilters = { ...card.filters };
    }
    this.setLastContentRequest({
      type: 'scenario',
      preference: card.preference,
      topic: card.summary || card.question
    });
    this.openScenarioModal(mode);
  }

  private queueScenarioFollowUp(result: { score: number }) {
    this.handleScenarioFollowUp(result).catch(err => console.error('Scenario follow-up error:', err));
  }

  private async handleScenarioFollowUp(result: { score: number }) {
    const score = Number(result.score ?? 0);
    const masteryScore = this.scenarioMasteryScore;
    const topic =
      this.lastScenarioFilters?.intent ||
      this.lastScenarioFilters?.summary ||
      this.scenarioQuestion ||
      this.documentTopic ||
      'that scenario';
    if (score >= masteryScore) {
      this.scenarioRemediation = undefined;
      this.scenarioRetryAttempts = 0;
      const topicLabel = this.formatTopicLabel(topic);
      this.addBotMessage(
        `Great job hitting ${score.toFixed(1)}/10 on ${topicLabel}! Want to keep building with another scenario or switch to a quiz?`
      );
      this.scheduleEngagementNudge('scenario', topic);
      return;
    }
    this.scenarioRetryAttempts += 1;
    await this.startScenarioRemediation(topic, masteryScore);
  }

  private replayLastScenarioCard() {
    if (!this.lastScenarioCard) return;
    const replayCard: ScenarioCardPayload = {
      ...this.lastScenarioCard,
      id: this.generateId('scenario-card'),
      filters: this.lastScenarioCard.filters ? { ...this.lastScenarioCard.filters } : undefined
    };
    this.addScenarioCard(replayCard);
    this.addBotMessage('Same scenario is ready—open it when you want to take another pass.');
  }

  private async startScenarioRemediation(topic: string, masteryScore: number) {
    const focus = topic || this.documentTopic || 'this scenario';
    const primer = this.buildScenarioPrimerContent(focus, masteryScore);
    this.addBotMessage(primer.html, primer.plain);

    const plan: ScenarioRemediationState = {
      topic: focus,
      totalQuizzes: 3,
      quizzesAsked: 0,
      quizzesCorrect: 0,
      preference: this.lastContentRequest?.preference === 'tailored' ? 'tailored' : 'classic',
      filters: this.lastScenarioFilters ? { ...this.lastScenarioFilters } : undefined,
      scenarioCard: this.lastScenarioCard
        ? {
            ...this.lastScenarioCard,
            filters: this.lastScenarioCard.filters ? { ...this.lastScenarioCard.filters } : undefined
          }
        : undefined
    };
    this.scenarioRemediation = plan;

    await this.requestKnowledgeCard('topic', focus);
    this.addBotMessage("Okay, now let's go for some quiz questions on this concept. We'll run three quick checks.");
    await this.launchRemediationQuiz();
  }

  private buildScenarioPrimerContent(topic: string, masteryScore: number) {
    const scenarioSummary = this.lastScenarioCard?.question || this.scenarioQuestion || 'this scenario';
    const focusLabel = this.formatTopicLabel(topic);
    const html = `
      <div class="scenario-primer">
        <h3>Let's start by understanding the core concepts behind this scenario.</h3>
        <p>We need at least ${masteryScore.toFixed(1)}/10 before switching it up, so let's ground ourselves first.</p>
        <h4>Scenario focus</h4>
        <p>${this.escapeHtml(scenarioSummary)}</p>
        <h4>Customer mindset</h4>
        <ul>
          <li>Validate the frustration before pitching solutions.</li>
          <li>Reference improvements that directly address their past pain.</li>
        </ul>
        <h4>Anchor talking points</h4>
        <ul>
          <li>Lead with the key upgrades tied to ${this.escapeHtml(focusLabel)}.</li>
          <li>Share one proof point (customer quote, metric, or spec) that proves the improvement.</li>
          <li>Close with an ask that keeps the conversation moving (trial, demo, next step).</li>
        </ul>
      </div>
    `;
    const plain = `Let's start by understanding this scenario. Focus on validating the frustration, highlighting improvements tied to ${focusLabel}, and ending with a clear next step.`;
    return { html, plain };
  }

  private async launchRemediationQuiz() {
    const plan = this.scenarioRemediation;
    if (!plan) return;
    if (plan.quizzesAsked >= plan.totalQuizzes) {
      await this.completeScenarioRemediation();
      return;
    }
    await this.requestQuiz('topic', plan.topic);
  }

  private async recordRemediationQuizResult(correct: boolean) {
    const plan = this.scenarioRemediation;
    if (!plan) return;
    plan.quizzesAsked += 1;
    if (correct) {
      plan.quizzesCorrect += 1;
    }
    if (plan.quizzesAsked >= plan.totalQuizzes) {
      await this.completeScenarioRemediation();
      return;
    }
    this.addBotMessage(
      `Got it. Quiz ${plan.quizzesAsked}/${plan.totalQuizzes} logged—here's another quick check on this concept.`
    );
    await this.launchRemediationQuiz();
  }

  private async recordQuizChallengeResult(correct: boolean) {
    const plan = this.quizChallenge;
    if (!plan) return;
    plan.attempted += 1;
    if (correct) {
      plan.correct += 1;
      this.addBotMessage(`Nice! You're at ${plan.correct}/${plan.targetCorrect} correct answers.`);
    } else {
      this.addBotMessage(
        `Not quite—still ${plan.correct}/${plan.targetCorrect} correct. Let's keep drilling until you hit five.`
      );
    }
    if (plan.correct >= plan.targetCorrect) {
      this.addBotMessage('Crushed it! Five correct answers logged. Ask for another challenge anytime.');
      this.quizChallenge = undefined;
      return;
    }
    await this.launchQuizChallengeQuestion();
  }

  private async completeScenarioRemediation() {
    const plan = this.scenarioRemediation;
    if (!plan) return;
    if (plan.quizzesCorrect >= 2) {
      this.addBotMessage('Nice work—you nailed the quick checks. Let’s revisit the scenario and apply it.');
      this.scenarioRemediation = undefined;
      if (this.lastScenarioCard) {
        this.replayLastScenarioCard();
        return;
      }
      if (plan.preference === 'tailored' && plan.filters) {
        await this.requestScenario('tailored', plan.filters, plan.filters.summary);
        return;
      }
      await this.requestScenario('classic');
      return;
    }
    this.addBotMessage(
      `We need at least two correct answers to move back into the scenario. You hit ${plan.quizzesCorrect}/${plan.totalQuizzes}. Let's review and try another quiz round.`
    );
    plan.quizzesAsked = 0;
    plan.quizzesCorrect = 0;
    await this.launchRemediationQuiz();
  }

  private prepareQuizSlot() {
    if (this.quizQuestion && this.quizOptions.length) {
      const card = this.createQuizHistoryCard();
      const placeholderIndex = this.removeActiveQuizMessage();
      if (card && this.quizAnswered) {
        this.addQuizHistoryCard(card, placeholderIndex ?? undefined);
      }
      this.resetQuizState();
    }
    this.currentQuizTopic = undefined;
  }

  private async requestQuiz(preference: QuizPreference, topic?: string) {
    if (!this.documentId) return;
    this.prepareQuizSlot();
    this.showLoadingOverlay('Loading a quiz question...');
    try {
      const maxAttempts = 5;
      let quizData: any | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const res = await fetch(`${this.API_BASE}/api/quiz`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: this.documentId,
            topic: preference === 'topic' ? topic : undefined,
            learnerProfile: this.getLearnerProfileSnapshot()
          })
        });
        if (!res.ok) {
          throw new Error(`Quiz request failed (${res.status})`);
        }
        const data = await res.json();
        const questionKey = this.normalizeKey(data?.question);
        if (questionKey && this.quizQuestionsSeen.has(questionKey)) {
          continue;
        }
        if (questionKey) {
          this.quizQuestionsSeen.add(questionKey);
        }
        quizData = data;
        break;
      }

      if (!quizData) {
        this.addBotMessage('I could not find a fresh quiz question right now. Please try again in a moment.');
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
      this.currentQuizTopic = quizData.topic || topic || this.extractKeywordsFromQuestion(quizData.question);
      this.lastQuizTopic = this.currentQuizTopic || this.quizQuestion;
      this.attachActiveQuizMessage();
      this.setLastContentRequest({ type: 'quiz', preference, topic: this.currentQuizTopic });
      this.quizChain += 1;
      this.knowledgeChain = 0;
      this.cardsSincePrompt += 1;
      this.maybeOfferLearningRecommendation(this.currentQuizTopic);
    } catch (err) {
      console.error('Quiz error:', err);
      this.addBotMessage('Sorry, I could not load a quiz question.');
    } finally {
      this.hideLoadingOverlay();
    }
  }

  private detectContentCommand(input: string): ContentCommand | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();

    if (this.isRepeatKeyword(normalized)) {
      const target = this.detectCardTypeFromText(normalized);
      return { kind: 'repeat', target };
    }

    const refinementCommand = this.detectRefinementCommand(trimmed);
    if (refinementCommand) {
      return refinementCommand;
    }

    if (normalized.includes('knowledge card') || normalized.startsWith('knowledge ')) {
      const match = trimmed.match(/knowledge(?:\s*card)?\s*(?:on|about|covering|focusing on|with)\s+(.+)/i);
      const topic = match?.[1]?.trim();
      return { kind: 'knowledge', topic };
    }

    if (normalized.includes('quiz')) {
      const match = trimmed.match(/quiz(?:\s*(?:card|question))?\s*(?:on|about)\s+(.+)/i);
      const topic = match?.[1]?.trim();
      return { kind: 'quiz', topic };
    }

    const genericCardCommand = this.detectGenericCardCommand(trimmed);
    if (genericCardCommand) {
      return genericCardCommand;
    }

    const scenarioTriggers = ['scenario card', 'run a scenario', 'another scenario', 'new scenario', 'scenario please'];
    const scenarioActionHints = ['give', 'gimme', 'need', 'want', 'practice', 'run', 'queue', 'another', 'new', 'idea', 'plan', 'try'];
    const scenarioRequested =
      scenarioTriggers.some(trigger => normalized.includes(trigger)) ||
      normalized.startsWith('scenario ') ||
      (this.containsWord(normalized, 'scenario') && scenarioActionHints.some(hint => normalized.includes(hint)));
    if (scenarioRequested) {
      const preference = normalized.includes('tailored') ? 'tailored' : 'classic';
      const useOutline =
        this.hasFreshScenarioOutline() &&
        ['this', 'above', 'that', 'it', 'same'].some(word => this.containsWord(normalized, word));
      return { kind: 'scenario', preference, useOutline };
    }

    return null;
  }

  private detectCardTypeFromText(text: string): 'knowledge' | 'quiz' | 'scenario' | undefined {
    if (text.includes('knowledge')) return 'knowledge';
    if (text.includes('quiz')) return 'quiz';
    if (text.includes('scenario')) return 'scenario';
    return undefined;
  }

  private detectRefinementCommand(input: string): ContentCommand | null {
    if (!this.lastContentRequest) return null;
    const normalized = input.toLowerCase();
    const refinementTriggers = [
      'make it',
      'make this',
      'can you make',
      'could you make',
      'can we make',
      'focus it',
      'focus this',
      'focus more',
      'more focused',
      'more technical',
      'more detailed',
      'more specific',
      'can you tailor',
      'tailor it',
      'can you adjust',
      'adjust it'
    ];
    if (!refinementTriggers.some(trigger => normalized.includes(trigger))) {
      return null;
    }

    const topicMatch = input.match(
      /(make(?: it| this)?|focus(?: more)?|about|on|tailor(?: it)?|adjust(?: it)?|specific to)\s+(.*)/i
    );
    const candidate = topicMatch?.[2]?.trim() || topicMatch?.[1]?.trim();
    const topic = candidate && candidate.length > 2 ? candidate : this.lastContentRequest.topic;

    if (this.lastContentRequest.type === 'knowledge') {
      return { kind: 'knowledge', topic };
    }
    if (this.lastContentRequest.type === 'quiz') {
      return { kind: 'quiz', topic };
    }
    if (this.lastContentRequest.type === 'scenario') {
      return { kind: 'scenario', preference: this.lastContentRequest.preference === 'tailored' ? 'tailored' : 'classic' };
    }
    return null;
  }

  private detectGenericCardCommand(input: string): ContentCommand | null {
    const normalized = input.toLowerCase();
    if (!normalized.includes('card')) return null;
    if (normalized.includes('knowledge') || normalized.includes('quiz') || normalized.includes('scenario')) {
      return null;
    }

    const topic =
      this.extractTopicFromLooseText(input) ||
      this.lastContentRequest?.topic ||
      this.lastKnowledgeFocus ||
      this.lastScenarioFilters?.intent ||
      this.lastScenarioFilters?.summary ||
      this.getAssistantContextTopic();

    const lastType = this.lastContentRequest?.type;
    if (lastType === 'quiz') {
      return { kind: 'quiz', topic };
    }
    if (lastType === 'scenario') {
      return { kind: 'knowledge', topic };
    }
    return { kind: 'knowledge', topic };
  }

  private shouldAutoServeOnboardingKnowledge(rawInput: string) {
    if (this.onboardingKnowledgeCardServed) return false;
    if (!this.documentTopic) return false;
    if (this.knowledgeTopicsSeen.size > 0) return false;
    const normalized = rawInput.trim().toLowerCase();
    if (!normalized) return false;
    const priorExperiencePrompted =
      (this.lastAssistantPlainText || '').toLowerCase().includes('prior experience') ||
      (this.lastAssistantPlainText || '').toLowerCase().includes('experience with this area');
    const negativeResponses = ['no', 'nope', 'nah', 'not really', 'no experience', 'none', 'never'];
    if (priorExperiencePrompted) {
      if (negativeResponses.includes(normalized) || normalized.includes('no experience')) {
        return true;
      }
    }
    const learningTriggers = [
      'teach me',
      'learn more',
      'tell me',
      'help me understand',
      'overview',
      'basics',
      'what is',
      'what can',
      'explain'
    ];
    return learningTriggers.some(trigger => normalized.includes(trigger));
  }

  private extractTopicFromLooseText(input: string) {
    const match = input.match(/(?:about|on|regarding|around|for|covering|focusing on|focused on)\s+(.+)/i);
    const candidate = match?.[1]?.trim();
    if (!candidate) return undefined;
    if (['same', 'this', 'that', 'it'].some(word => this.containsWord(candidate.toLowerCase(), word))) {
      return undefined;
    }
    return candidate;
  }

  private containsWord(text: string, word: string) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`);
    return regex.test(text);
  }

  private pickKnowledgeFocus(...candidates: (string | undefined)[]) {
    for (const candidate of candidates) {
      const value = (candidate || '').trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private extractKeywordsFromSnippet(snippet?: string) {
    if (!snippet) return undefined;
    const sentence = snippet.split(/[.!?]/)[0]?.trim();
    if (!sentence) return undefined;
    return sentence.length > 80 ? sentence.slice(0, 80) : sentence;
  }

  private extractKeywordsFromQuestion(question?: string) {
    if (!question) return undefined;
    return question.length > 80 ? question.slice(0, 80) : question;
  }

  private getAssistantContextTopic() {
    if (!this.lastAssistantPlainText) return undefined;
    return this.lastAssistantPlainText.length > 200
      ? this.lastAssistantPlainText.slice(0, 200)
      : this.lastAssistantPlainText;
  }

  private formatTopicLabel(raw?: string) {
    if (!raw) return 'that topic';
    const trimmedRaw = raw.trim();
    const questionLike = /[?]/.test(trimmedRaw) || /^(what|which|when|where|why|how)\b/i.test(trimmedRaw);
    if (questionLike) {
      return 'this concept';
    }
    let text = trimmedRaw.replace(/\(.*?\)/g, '').replace(/["']/g, '').trim();
    const patterns = [
      { match: /^needs?\s+(another\s+rep|more practice)\s+on\s+/i, replace: '' },
      { match: /^quiz miss on\s+/i, replace: '' },
      { match: /^missed\s+/i, replace: '' },
      { match: /^focus on\s+/i, replace: '' }
    ];
    patterns.forEach(({ match, replace }) => {
      text = text.replace(match, replace);
    });
    text = text.replace(/\s*score[^\s,.]+.*$/i, '').trim();
    text = text.replace(/[?!.]+$/, '').trim();
    if (!text) {
      return 'that topic';
    }
    return text;
  }

  private pickWeaknessSuggestionType(text: string): SuggestionPrompt['cardType'] {
    const lowered = text.toLowerCase();
    if (lowered.includes('scenario') || lowered.includes('role-play') || lowered.includes('conversation')) {
      return 'scenario';
    }
    if (lowered.includes('quiz') || lowered.includes('question') || lowered.includes('accuracy')) {
      return 'quiz';
    }
    return 'knowledge';
  }

  private isRepeatKeyword(text: string) {
    if (text.includes('no more')) {
      return false;
    }
    const keywords = [
      'again',
      'one more',
      'another',
      'keep going',
      'keep it going',
      'keep it coming',
      'keep coming',
      'more please',
      'more',
      'repeat',
      'continue',
      'let\'s keep going'
    ];
    return keywords.some(keyword => text === keyword || text.endsWith(keyword) || text.startsWith(keyword));
  }

  private async executeContentCommand(command: ContentCommand) {
    this.pendingSuggestion = null;
    switch (command.kind) {
      case 'knowledge':
        if (command.topic) {
          this.addKnowledgeGap(`Requested deeper coverage on "${command.topic}".`);
        }
        await this.requestKnowledgeCard(command.topic ? 'topic' : 'pathway', command.topic);
        return;
      case 'quiz':
        await this.requestQuiz(command.topic ? 'topic' : 'arbitrary', command.topic);
        return;
      case 'scenario':
        if (command.useOutline) {
          const outline = this.getFreshScenarioOutline();
          if (outline) {
            const parsed = this.parseScenarioDetails(outline);
            await this.requestScenario('tailored', parsed, parsed.summary);
            return;
          }
        }
        if (command.preference === 'classic') {
          await this.requestScenario('classic');
        } else {
          this.pendingFlow = { type: 'scenario', step: 'details', preference: 'tailored', data: {} };
          this.addBotMessage(
            'Great—describe the scenario in one message. Mention the customer situation, industry, target audience, and intent if you can.'
          );
        }
        return;
      case 'repeat':
        await this.handleRepeatCommand(command);
        return;
    }
  }

  private async handleRepeatCommand(command: Extract<ContentCommand, { kind: 'repeat' }>) {
    const explicitTarget = command.target;
    const inferredTarget = this.lastContentRequest?.type;
    const target = explicitTarget || inferredTarget;

    if (!target) {
      this.addBotMessage('Happy to keep going—just let me know if you want another knowledge card, quiz, or scenario.');
      return;
    }

    if (target === 'knowledge') {
      const topicSource = this.lastContentRequest?.type === 'knowledge' ? this.lastContentRequest?.topic : undefined;
      await this.requestKnowledgeCard(topicSource ? 'topic' : 'pathway', topicSource);
      return;
    }

    if (target === 'quiz') {
      const topicSource = this.lastContentRequest?.type === 'quiz' ? this.lastContentRequest?.topic : undefined;
      await this.requestQuiz(topicSource ? 'topic' : 'arbitrary', topicSource);
      return;
    }

    if (target === 'scenario') {
      if (this.lastContentRequest?.preference === 'tailored' && this.lastScenarioFilters) {
        await this.requestScenario('tailored', this.lastScenarioFilters, this.lastScenarioFilters.summary);
      } else {
        await this.requestScenario('classic');
      }
    }
  }

  private async handleSuggestionResponse(rawInput: string): Promise<boolean> {
    if (!this.pendingSuggestion) return false;
    const normalized = rawInput.trim().toLowerCase();
    if (!normalized) return false;
    if (this.isAffirmativeResponse(normalized)) {
      const suggestion = this.pendingSuggestion;
      this.pendingSuggestion = null;
      await this.executeSuggestion(suggestion);
      return true;
    }
    if (this.isNegativeResponse(normalized)) {
      this.pendingSuggestion = null;
      this.addBotMessage('No problem—just ask whenever you want another recommendation.');
      return true;
    }
    return false;
  }

  private isAffirmativeResponse(text: string) {
    const positives = ['yes', 'yep', 'sure', 'ok', 'okay', 'let\'s do it', 'do it', 'please', 'yeah', 'go ahead'];
    return positives.some(word => text === word || text.startsWith(`${word} `) || text.includes(` ${word}`));
  }

  private isNegativeResponse(text: string) {
    const negatives = ['no', 'nope', 'not now', 'maybe later', 'stop', 'nah', 'pass', 'not really'];
    return negatives.some(word => text === word || text.startsWith(`${word} `) || text.includes(` ${word}`));
  }

  private async executeSuggestion(suggestion: SuggestionPrompt) {
    if (suggestion.cardType === 'knowledge') {
      const topic =
        suggestion.topic ||
        this.lastKnowledgeFocus ||
        this.getAssistantContextTopic() ||
        this.lastContentRequest?.topic;
      await this.requestKnowledgeCard(topic ? 'topic' : 'pathway', topic);
      return;
    }
    if (suggestion.cardType === 'quiz') {
      await this.requestQuiz(suggestion.topic ? 'topic' : 'arbitrary', suggestion.topic);
      return;
    }
    await this.requestScenario('classic');
  }

  private describeSuggestionPrompt(suggestion: SuggestionPrompt) {
    const topicLabel = this.formatTopicLabel(suggestion.topic);
    if (suggestion.cardType === 'knowledge') {
      return suggestion.reason === 'weakness'
        ? `Want a quick refresher knowledge card to shore up ${topicLabel}?`
        : `Need a summary knowledge card to review ${topicLabel}?`;
    }
    if (suggestion.cardType === 'quiz') {
      return suggestion.reason === 'weakness'
        ? `Want a quiz card to drill ${topicLabel}?`
        : `Want me to quiz you on ${topicLabel}?`;
    }
    return suggestion.reason === 'weakness'
      ? `Want to practice ${topicLabel} in a fast scenario?`
      : `Ready for a scenario to apply what you just learned about ${topicLabel}?`;
  }

  private promptRecommendation(suggestion: SuggestionPrompt) {
    const now = Date.now();
    if (this.pendingSuggestion || now - this.lastSuggestionTimestamp < this.suggestionCooldownMs) {
      return;
    }
    this.lastSuggestionTimestamp = now;
    this.pendingSuggestion = suggestion;
    this.addBotMessage(this.describeSuggestionPrompt(suggestion));
  }

  private maybeOfferLearningRecommendation(topic?: string) {
    if (this.pendingSuggestion) return;
    if (this.cardsSincePrompt < 5) return;
    const triggeredByKnowledge = this.knowledgeChain >= 2;
    const triggeredByQuiz = this.quizChain >= 2;
    if (triggeredByKnowledge || triggeredByQuiz) {
      const focus = topic || this.lastKnowledgeFocus || this.getAssistantContextTopic();
      const suggestion: SuggestionPrompt = triggeredByKnowledge
        ? { cardType: 'scenario', reason: 'learning', topic: focus }
        : { cardType: 'knowledge', reason: 'learning', topic: focus, variant: 'summary' };
      this.promptRecommendation(suggestion);
      this.knowledgeChain = 0;
      this.quizChain = 0;
      this.cardsSincePrompt = 0;
    }
  }

  private maybeOfferWeaknessRecommendation() {
    if (this.pendingSuggestion || this.cardsSincePrompt < 5) return;
    const weakness = this.learnerProfile.weaknesses.slice(-1)[0];
    if (!weakness) return;
    const weaknessType = this.pickWeaknessSuggestionType(weakness);
    const suggestion: SuggestionPrompt =
      weaknessType === 'knowledge'
        ? { cardType: 'knowledge', reason: 'weakness', topic: weakness, variant: 'summary' }
        : {
            cardType: weaknessType,
            reason: 'weakness',
            topic: weakness
          };
    this.promptRecommendation(suggestion);
    this.cardsSincePrompt = 0;
  }

  private scheduleEngagementNudge(source: 'knowledge' | 'quiz' | 'scenario', focus?: string) {
    const now = Date.now();
    if (now - this.lastEngagementNudge < this.engagementCooldownMs) {
      return;
    }
    const anchor =
      focus ||
      this.lastKnowledgeFocus ||
      this.learnerProfile.knowledgeGaps.slice(-1)[0] ||
      this.documentTopic ||
      'this product';
    const topicLabel = this.formatTopicLabel(anchor);
    let message = '';
    switch (source) {
      case 'knowledge':
        message = `Want to act on ${topicLabel}? I can spin up a quiz or scenario to keep it moving.`;
        break;
      case 'quiz':
        message = `Ready for another rep on ${topicLabel}? I can grab a fresh quiz or share a knowledge card.`;
        break;
      default:
        message = `Need a different angle on ${topicLabel}? Ask for a quiz or knowledge card and I'll queue it right away.`;
        break;
    }
    this.lastEngagementNudge = now;
    this.addBotMessage(message);
  }

  private setLastContentRequest(entry: { type: 'knowledge' | 'quiz' | 'scenario'; preference?: string; topic?: string }) {
    this.lastContentRequest = entry;
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
      this.updateProfileFromQuizResult();
      await this.handleQuizOutcome();
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

  private captureLearnerNote(note?: string) {
    const trimmed = note?.trim();
    if (!trimmed) return;
    const notes = [...this.learnerProfile.notes, trimmed];
    if (notes.length > 20) {
      notes.shift();
    }
    this.learnerProfile.notes = notes;
  }

  private getLearnerProfileSnapshot(): LearnerProfile {
    return {
      strengths: [...this.learnerProfile.strengths],
      weaknesses: [...this.learnerProfile.weaknesses],
      knowledgeGaps: [...this.learnerProfile.knowledgeGaps],
      notes: [...this.learnerProfile.notes]
    };
  }

  private addStrength(entry?: string) {
    if (!entry) return;
    this.learnerProfile.strengths = this.appendProfileEntry(this.learnerProfile.strengths, entry);
  }

  private addWeakness(entry?: string) {
    if (!entry) return;
    this.learnerProfile.weaknesses = this.appendProfileEntry(this.learnerProfile.weaknesses, entry);
  }

  private addKnowledgeGap(entry?: string) {
    if (!entry) return;
    this.learnerProfile.knowledgeGaps = this.appendProfileEntry(this.learnerProfile.knowledgeGaps, entry, 12);
  }

  private appendProfileEntry(list: string[], entry: string, max = 8) {
    const normalized = entry.trim();
    if (!normalized) {
      return list;
    }
    const filtered = list.filter(item => item !== normalized);
    filtered.push(normalized);
    if (filtered.length > max) {
      filtered.splice(0, filtered.length - max);
    }
    return filtered;
  }

  private updateProfileFromScenario(result: { score: number; feedback: string }) {
    const score = Number(result.score ?? 0);
    const contextPieces: string[] = [];
    if (this.lastScenarioFilters?.intent) {
      contextPieces.push(this.lastScenarioFilters.intent);
    }
    if (this.lastScenarioFilters?.industry) {
      contextPieces.push(this.lastScenarioFilters.industry);
    }
    const context = contextPieces.join(' / ');
    const hasSpecificContext = contextPieces.length > 0;
    const displayContext = hasSpecificContext ? context : 'scenario fundamentals';
    if (score >= 8) {
      const scenarioLabel = hasSpecificContext ? `${context} scenario` : displayContext;
      this.addStrength(`Handled ${scenarioLabel} with a ${score.toFixed(1)}/10 score.`);
    } else if (score <= 6) {
      const suffix = hasSpecificContext ? ' scenarios' : '';
      this.addWeakness(`Needs another rep on ${displayContext}${suffix} (scored ${score.toFixed(1)}/10).`);
    }
    if (result.feedback) {
      const summary = result.feedback.split('.').slice(0, 2).join('.').trim();
      if (summary) {
        this.addKnowledgeGap(summary);
      }
    }
  }

  private updateProfileFromQuizResult() {
    if (!this.quizAnswered || !this.quizQuestion) return;
    const topic = this.currentQuizTopic || this.quizQuestion;
    if (this.quizCorrect) {
      this.addStrength(`Answered quiz on "${topic}" correctly.`);
    } else {
      this.addKnowledgeGap(`Quiz miss on "${topic}" — revisit this topic.`);
      this.maybeOfferWeaknessRecommendation();
    }
  }

  private async handleQuizOutcome() {
    if (!this.quizAnswered) return;
    if (this.scenarioRemediation) {
      await this.recordRemediationQuizResult(this.quizCorrect);
      return;
    }
    if (this.quizChallenge) {
      await this.recordQuizChallengeResult(this.quizCorrect);
      return;
    }
    const topic = this.lastQuizTopic || this.quizQuestion || 'that topic';
    if (!this.quizCorrect) {
      const topicLabel = this.formatTopicLabel(topic);
      this.addBotMessage(`You weren't quite there with that one on ${topicLabel}. Let's try another question on it.`);
      await this.requestQuiz('topic', topic);
      return;
    }
    this.scheduleEngagementNudge('quiz', topic);
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
    const plain = `Knowledge card: ${card.title} — ${card.snippet}`;
    this.chatHistory.push({ role: 'assistant', content: plain });
    this.lastAssistantPlainText = plain;
    this.scheduleScrollToBottom();
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
      this.closeScenarioModal();
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
    this.updateProfileFromScenario(result);
    this.maybeOfferWeaknessRecommendation();
    this.queueScenarioFollowUp(result);
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

  private stripHtml(html: string) {
    if (!html) return '';
    return html.replace(/<[^>]+>/g, '').trim();
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

  private generateId(prefix: string) {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
  }

  toggleKnowledgeAudio(audioId?: string) {
    if (!audioId) return;
    const audio = this.getAudioElement(audioId);
    if (!audio) return;

    if (audio.paused) {
      this.pauseAllKnowledgeAudio(audioId);
      audio.play().catch(err => console.error('Audio play error', err));
      this.setKnowledgeAudioState(audioId, { playing: true });
    } else {
      audio.pause();
      this.setKnowledgeAudioState(audioId, { playing: false });
    }
  }

  private pauseAllKnowledgeAudio(exceptId?: string) {
    Object.keys(this.knowledgeAudioState).forEach(id => {
      if (id === exceptId) return;
      const audio = this.getAudioElement(id);
      if (audio && !audio.paused) {
        audio.pause();
        this.setKnowledgeAudioState(id, { playing: false });
      }
    });
  }

  onKnowledgeAudioLoaded(audioId: string, event: Event) {
    const audio = event.target as HTMLAudioElement;
    const state = this.knowledgeAudioState[audioId] || { volume: 0.85, speed: 1 };
    audio.volume = state.volume ?? 0.85;
    audio.playbackRate = state.speed ?? 1;
    this.setKnowledgeAudioState(audioId, { duration: audio.duration || 0 });
  }

  onKnowledgeAudioTime(audioId: string, event: Event) {
    const audio = event.target as HTMLAudioElement;
    this.setKnowledgeAudioState(audioId, {
      current: audio.currentTime,
      duration: audio.duration || this.knowledgeAudioState[audioId]?.duration || 0
    });
  }

  onKnowledgeAudioEnded(audioId: string) {
    this.setKnowledgeAudioState(audioId, { playing: false, current: 0 });
  }

  seekKnowledgeAudio(audioId: string, evt: MouseEvent) {
    const audio = this.getAudioElement(audioId);
    if (!audio || !audio.duration) return;
    const track = evt.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(Math.max((evt.clientX - rect.left) / rect.width, 0), 1);
    audio.currentTime = ratio * audio.duration;
    this.setKnowledgeAudioState(audioId, { current: audio.currentTime, duration: audio.duration });
  }

  getKnowledgeProgress(audioId?: string) {
    if (!audioId) return 0;
    const state = this.knowledgeAudioState[audioId];
    if (!state || !state.duration) return 0;
    return (state.current / state.duration) * 100;
  }

  isKnowledgeAudioPlaying(audioId?: string) {
    if (!audioId) return false;
    return !!this.knowledgeAudioState[audioId]?.playing;
  }

  formatAudioTime(audioId?: string) {
    if (!audioId) return '0:00 / 0:00';
    const state = this.knowledgeAudioState[audioId];
    const current = state?.current || 0;
    const duration = state?.duration || 0;
    return `${this.formatSeconds(current)} / ${this.formatSeconds(duration)}`;
  }

  private formatSeconds(value: number) {
    if (!isFinite(value)) return '0:00';
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60)
      .toString()
      .padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  ensureKnowledgeAudioId(card: KnowledgeCardPayload) {
    if (!card.audioId) {
      card.audioId = this.generateId('knowledge-audio');
    }
    return card.audioId;
  }

  private getAudioElement(id: string) {
    return document?.getElementById(id) as HTMLAudioElement | null;
  }

  getKnowledgeVolume(audioId?: string) {
    if (!audioId) return 0.85;
    return this.knowledgeAudioState[audioId]?.volume ?? 0.85;
  }

  getKnowledgeSpeed(audioId?: string) {
    if (!audioId) return 1;
    return this.knowledgeAudioState[audioId]?.speed ?? 1;
  }

  toggleKnowledgeMenu(audioId: string) {
    this.knowledgeMenuOpenId = this.knowledgeMenuOpenId === audioId ? undefined : audioId;
  }

  setKnowledgeSpeed(audioId: string, speed: number) {
    const audio = this.getAudioElement(audioId);
    if (!audio) return;
    audio.playbackRate = speed;
    this.setKnowledgeAudioState(audioId, { speed });
    this.knowledgeMenuOpenId = undefined;
  }

  setKnowledgeVolume(audioId: string, volume: number) {
    const audio = this.getAudioElement(audioId);
    if (!audio) return;
    audio.volume = volume;
    this.setKnowledgeAudioState(audioId, { volume });
  }

  private setKnowledgeAudioState(
    id: string,
    patch: Partial<{ playing: boolean; current: number; duration: number; volume: number; speed: number }>
  ) {
    const existing =
      this.knowledgeAudioState[id] || { playing: false, current: 0, duration: 0, volume: 0.85, speed: 1 };
    this.knowledgeAudioState = {
      ...this.knowledgeAudioState,
      [id]: { ...existing, ...patch }
    };
  }
}