from django.urls import path

from . import views

urlpatterns = [
    path("documents", views.upload_document, name="upload_document"),
    path("knowledge-card", views.get_knowledge_card, name="knowledge_card"),
    path("topic", views.get_topic, name="topic"),
    path("scenario", views.get_scenario, name="scenario"),
    path("scenario/answer", views.evaluate_scenario, name="scenario_answer"),
    path("quiz", views.get_quiz, name="quiz"),
    path("quiz/answer", views.submit_quiz, name="quiz_answer"),
    path("question", views.get_question, name="question"),
    path("chat", views.chat_with_document, name="chat"),
    path("text", views.handle_text, name="text"),
    path("audio", views.handle_audio, name="audio"),
    path("rubric", views.rubric_handler, name="rubric"),
]


