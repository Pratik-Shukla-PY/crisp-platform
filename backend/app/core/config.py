from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "CRISP API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"
    
    # Using SQLite for seamless local testing without Postgres setup overhead.
    # Production should swap back to: "postgresql://user:pass@localhost/db"
    DATABASE_URL: str = "sqlite:///./crisp_local.db"

    class Config:
        env_file = ".env"

settings = Settings()
