import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { DocumentMetadata, DocumentStateService } from '../../services/document-state.service';
import { AdminConfigService } from '../../services/admin-config.service';
import { AdminScenarioConfig, AdminTrainingConfig, EMPTY_ADMIN_CONFIG, ScenarioFlowData } from '../../types/training-config';

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
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './document-upload.component.html',
  styleUrls: ['./document-upload.component.css']
})
export class DocumentUploadComponent implements OnInit {
  readonly API_BASE = 'http://127.0.0.1:8000';
  private readonly TRAINING_TEMPLATE_KEY = 'adminTrainingTemplate';

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
  adminConfig: AdminTrainingConfig = {
    ...EMPTY_ADMIN_CONFIG,
    mandatoryScenarios: [],
    minimums: { ...EMPTY_ADMIN_CONFIG.minimums }
  };
  adminConfigLoading = false;
  adminConfigSaving = false;
  adminConfigError = '';
  adminConfigNotice = '';
  adminConfigSaved = true;
  pendingPracticeNavigation = false;

  constructor(
    private documentState: DocumentStateService,
    private router: Router,
    private adminConfigService: AdminConfigService
  ) {
    const meta = this.documentState.getMetadata();
    if (meta) {
      this.documentId = meta.id;
      this.documentMeta = meta;
    }
  }

  ngOnInit() {
    this.loadAdminConfig();
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
      this.pendingPracticeNavigation = true;
      this.adminConfigSaved = false;
      this.adminConfigError =
        'Review & save the admin scenario setup to unlock practice for this document.';
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

  trackScenario(index: number, scenario: AdminScenarioConfig) {
    return scenario.id || index;
  }

  addMandatoryScenario() {
    this.adminConfig.mandatoryScenarios.push(this.createScenarioDraft());
    this.markAdminConfigDirty();
  }

  removeMandatoryScenario(index: number) {
    this.adminConfig.mandatoryScenarios.splice(index, 1);
    this.markAdminConfigDirty();
  }

  moveMandatoryScenario(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= this.adminConfig.mandatoryScenarios.length) {
      return;
    }
    const scenarios = this.adminConfig.mandatoryScenarios;
    [scenarios[index], scenarios[targetIndex]] = [scenarios[targetIndex], scenarios[index]];
    this.markAdminConfigDirty();
  }

  async loadAdminConfig() {
    this.adminConfigLoading = true;
    this.clearAdminMessages();
    try {
      const config = await this.adminConfigService.getConfig();
      this.adminConfig = this.cloneAdminConfig(config);
      this.adminConfigSaved = false;
      this.adminConfigNotice = 'Save your admin setup to unlock practice.';
    } catch (err) {
      console.error('Failed to load admin config:', err);
      this.adminConfigError = 'Unable to load admin setup from the server.';
    } finally {
      this.adminConfigLoading = false;
    }
  }

  async saveAdminSetup() {
    if (this.adminConfigSaving) return;
    this.clearAdminMessages();
    const hasEmptyQuestion = this.adminConfig.mandatoryScenarios.some(s => !s.question.trim());
    if (hasEmptyQuestion) {
      this.adminConfigError = 'Each mandatory scenario needs a question before saving.';
      return;
    }
    this.adminConfigSaving = true;
    try {
      const payload: AdminTrainingConfig = {
        mandatoryScenarios: this.adminConfig.mandatoryScenarios.map(scenario => ({
          ...scenario,
          title: scenario.title?.trim() || '',
          summary: scenario.summary?.trim() || '',
          question: scenario.question.trim(),
          preference: scenario.preference === 'tailored' ? 'tailored' : 'classic',
          filters: this.sanitizeFilters(scenario.filters)
        })),
        minimums: {
          knowledge: this.normalizeMinimum(this.adminConfig.minimums.knowledge),
          quiz: this.normalizeMinimum(this.adminConfig.minimums.quiz),
          scenario: this.normalizeMinimum(this.adminConfig.minimums.scenario)
        }
      };
      const saved = await this.adminConfigService.saveConfig(payload);
      this.adminConfig = this.cloneAdminConfig(saved);
      this.adminConfigNotice = 'Admin setup saved successfully.';
      this.adminConfigSaved = true;
      this.adminConfigError = '';
      this.persistTrainingTemplate(saved);
      if (this.pendingPracticeNavigation && this.documentId) {
        this.pendingPracticeNavigation = false;
        this.navigateToPractice();
      }
    } catch (err) {
      console.error('Failed to save admin config:', err);
      this.adminConfigError = err instanceof Error ? err.message : 'Unable to save admin setup.';
    } finally {
      this.adminConfigSaving = false;
    }
  }

  private clearAdminMessages() {
    this.adminConfigError = '';
    this.adminConfigNotice = '';
  }

  private cloneAdminConfig(config: AdminTrainingConfig): AdminTrainingConfig {
    return {
      mandatoryScenarios: (config.mandatoryScenarios || []).map(scenario => ({
        ...scenario,
        title: scenario.title || '',
        summary: scenario.summary || '',
        question: scenario.question || '',
        preference: scenario.preference === 'tailored' ? 'tailored' : 'classic',
        filters: { ...(scenario.filters || {}) } as ScenarioFlowData
      })),
      minimums: {
        knowledge: this.normalizeMinimum(config.minimums?.knowledge),
        quiz: this.normalizeMinimum(config.minimums?.quiz),
        scenario: this.normalizeMinimum(config.minimums?.scenario)
      }
    };
  }

  private createScenarioDraft(): AdminScenarioConfig {
    return {
      id: this.generateScenarioId(),
      title: '',
      question: '',
      summary: '',
      preference: 'classic',
      filters: {} as ScenarioFlowData
    };
  }

  private generateScenarioId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `scenario-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private sanitizeFilters(filters?: ScenarioFlowData) {
    if (!filters) return undefined;
    const cleaned: ScenarioFlowData = {};
    (Object.keys(filters) as (keyof ScenarioFlowData)[]).forEach(key => {
      const value = filters[key];
      if (!value) return;
      const trimmed = value.toString().trim();
      if (trimmed) {
        cleaned[key] = trimmed;
      }
    });
    return Object.keys(cleaned).length ? cleaned : undefined;
  }

  private normalizeMinimum(value: number | string | undefined) {
    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      return 0;
    }
    return Math.floor(parsed);
  }

  ensureScenarioFilters(scenario: AdminScenarioConfig): ScenarioFlowData {
    if (!scenario.filters) {
      scenario.filters = {} as ScenarioFlowData;
    }
    return scenario.filters;
  }

  private navigateToPractice() {
    this.router.navigate(['/practice']);
  }

  markAdminConfigDirty() {
    if (this.adminConfigLoading) {
      return;
    }
    this.adminConfigSaved = false;
    if (!this.adminConfigSaving) {
      this.adminConfigNotice = '';
    }
  }

  loadSavedTrainingTemplate() {
    const template = this.retrieveTrainingTemplate();
    if (!template) {
      this.adminConfigError = 'No saved training template found.';
      return;
    }
    this.adminConfig = this.cloneAdminConfig(template);
    this.markAdminConfigDirty();
    this.adminConfigNotice = 'Loaded saved training template. Save it to apply to this training.';
  }

  private persistTrainingTemplate(config: AdminTrainingConfig) {
    try {
      localStorage.setItem(this.TRAINING_TEMPLATE_KEY, JSON.stringify(config));
    } catch {
      // Ignore storage errors.
    }
  }

  private retrieveTrainingTemplate(): AdminTrainingConfig | undefined {
    try {
      const raw = localStorage.getItem(this.TRAINING_TEMPLATE_KEY);
      if (!raw) return undefined;
      return JSON.parse(raw) as AdminTrainingConfig;
    } catch {
      return undefined;
    }
  }
}