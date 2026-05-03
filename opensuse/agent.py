import os
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.plugins import deepgram, openai, inworld, silero

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

SYSTEM_INSTRUCTIONS = os.getenv(
    "AGENT_INSTRUCTIONS",
    "Du bist ein hilfreicher KI-Sprachassistent in einem Telefonat. "
    "Sei höflich, professionell und antworte präzise auf Deutsch. "
    "Halte deine Antworten kurz und natürlich.",
)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    stt = deepgram.STT(
        model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
        language=os.getenv("DEEPGRAM_LANGUAGE", "de"),
        api_key=os.getenv("DEEPGRAM_API_KEY"),
    )
    llm = openai.LLM(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        base_url=os.getenv("LLM_BASE_URL"),
        api_key=os.getenv("LLM_API_KEY"),
    )
    tts = inworld.TTS(
        base_url=os.getenv("INWORLD_BASE_URL", "https://api.inworld.ai/v1"),
        api_key=os.getenv("INWORLD_API_KEY"),
        voice=os.getenv("INWORLD_VOICE_ID", ""),
    )
    vad = silero.VAD.load()

    session = AgentSession(vad=vad, stt=stt, llm=llm, tts=tts)
    agent = Agent(instructions=SYSTEM_INSTRUCTIONS)

    await session.start(agent=agent, room=ctx.room)
    await session.generate_reply(
        instructions="Greet the caller in German and ask how you can help."
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="voice-agent",
        )
    )