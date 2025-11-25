# VoiceCoachApp

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.2.13.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Backend setup

1. Create a `.env` file inside the `Backend/` directory with your OpenAI key:

   ```
   OPENAI_API_KEY=sk-...
   ```

2. Install backend dependencies and start FastAPI:

   ```bash
   cd Backend
   source venv/bin/activate  # or python -m venv venv && source venv/bin/activate
   pip install -r requirements.txt
   python main.py
   ```

The backend serves uploads at `http://127.0.0.1:8000/uploads/*` and exposes new endpoints for document upload, knowledge, scenario, and quiz cards.

## Document-first workflow

1. Navigate to `http://localhost:4200/` and upload a DOCX/PPT/PDF file.
2. Review the automatically generated **Knowledge Card** (summary + voice-over).
3. Expand the **Scenario Card** to answer one coaching prompt and score your response.
4. Expand the **Quiz Card** to answer a generated MCQ and view instant feedback.
5. Use the “Go to practice” link to jump into the legacy chat experience; it now reuses the most recently uploaded document automatically.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
