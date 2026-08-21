"""Container entry point for the API and worker roles."""

from __future__ import annotations

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(prog="markitdown-service")
    parser.add_argument("role", choices=("api", "worker"))
    args = parser.parse_args()

    if args.role == "worker":
        from .worker import run_worker

        run_worker()
        return

    import uvicorn

    from .config import Settings

    settings = Settings.from_environment(require_tokens=True)
    uvicorn.run(
        "markitdown_service.api:app",
        host=settings.bind_host,
        port=settings.bind_port,
        workers=1,
        access_log=True,
        proxy_headers=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
