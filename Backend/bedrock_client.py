import json
import os
from typing import Optional

import boto3


AWS_REGION = os.getenv("AWS_REGION")
AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
BEDROCK_MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "apac.anthropic.claude-3-5-sonnet-20240620-v1:0")

_bedrock_runtime = None


def get_bedrock_runtime():
    global _bedrock_runtime
    if _bedrock_runtime is None:
        if not AWS_REGION:
            raise RuntimeError("AWS_REGION is not set for Bedrock.")
        _bedrock_runtime = boto3.client(
            "bedrock-runtime",
            region_name=AWS_REGION,
            aws_access_key_id=AWS_ACCESS_KEY_ID,
            aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        )
    return _bedrock_runtime


def bedrock_completion(prompt: str, max_tokens: int = 512, temperature: float = 0.7, system: Optional[str] = None) -> str:
    """
    Simple wrapper to call an Anthropic Claude model on Bedrock and return plain text.
    """
    client = get_bedrock_runtime()

    messages = [
        {
            "role": "user",
            "content": [{"type": "text", "text": prompt}],
        }
    ]

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": messages,
    }
    if system:
        body["system"] = [{"type": "text", "text": system}]

    response = client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps(body).encode("utf-8"),
    )
    raw = response["body"].read()
    data = json.loads(raw)

    # For Anthropic models, text is under content[0].text
    try:
        return data["content"][0]["text"]
    except Exception:
        # Fallback for any other shapes
        if "output_text" in data:
            return data["output_text"]
        return str(data)


