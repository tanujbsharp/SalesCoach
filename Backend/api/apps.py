from django.apps import AppConfig


class ApiConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "api"

    def ready(self) -> None:
        # Importing here to trigger bootstrap of in-memory documents on startup.
        from . import services  # noqa: F401

        return super().ready()


