import { Routes } from '@angular/router';
import { ChatComponent } from './components/chat/chat.component';
import { DocumentUploadComponent } from './components/document-upload/document-upload.component';
import { InstructionsComponent } from './components/instructions/instructions.component';

export const routes: Routes = [
  { path: '', component: DocumentUploadComponent },
  { path: 'practice', component: ChatComponent },
  { path: 'instructions', component: InstructionsComponent },
  { path: '**', redirectTo: '' }
];