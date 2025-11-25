import { CommonModule, isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnInit, PLATFORM_ID } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

@Component({
  selector: 'app-instructions',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './instructions.component.html',
  styleUrls: ['./instructions.component.css']
})
export class InstructionsComponent implements OnInit {
  rubric: { name: string; description: string }[] = [];

  constructor(private router: Router, @Inject(PLATFORM_ID) private platformId: Object) {}

  ngOnInit(): void {
    if (!this.isBrowser()) return;

    fetch('http://127.0.0.1:8000/api/rubric')
      .then(res => res.json())
      .then(data => {
        this.rubric = data.rubric || [];
      })
      .catch(err => {
        console.error('❌ Failed to load rubric:', err);
        this.notify('Error loading rubric from server.');
      });
  }

  saveRubric() {
    if (!this.isBrowser()) return;

    fetch('http://127.0.0.1:8000/api/rubric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rubric: this.rubric })
    })
      .then(res => res.json())
      .then(() => {
        this.notify('Rubric updated!');
      })
      .catch(err => {
        console.error('❌ Failed to save rubric:', err);
        this.notify('Error saving rubric.');
      });
  }

  goToChat() {
    this.router.navigate(['/practice']);
  }

  addCriterion() {
    this.rubric.push({ name: '', description: '' });
  }

  removeCriterion(index: number) {
    this.rubric.splice(index, 1);
  }

  private notify(message: string) {
    if (this.isBrowser() && typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message);
    } else {
      console.log(message);
    }
  }

  private isBrowser() {
    return isPlatformBrowser(this.platformId);
  }
}
