# image_gen

Простой интерфейс для генерации изображений через Polza.ai Media API и модель `openai/gpt-5.4-image-2`.

## Что внутри

- Промпт, формат, разрешение, количество изображений и выбор модели.
- Доступные модели: `openai/gpt-5.4-image-2` и `google/gemini-3.1-flash-image-preview`.
- Загрузка референсов и фото персонажей с клиентским сжатием перед отправкой.
- История генераций в браузере: задачи и результаты сохраняются локально, запуск передается service worker, незавершенные задачи продолжают проверяться после повторного открытия страницы.
- Серверные эндпоинты `/api/generate` и `/api/status`, чтобы ключ Polza не попадал в браузер.
- Готовая структура для GitHub + Vercel.

## Локальный запуск

1. Создайте `.env.local`:

   ```bash
   POLZA_API_KEY=ваш_ключ_polza
   ```

2. Запустите:

   ```bash
   npm run dev
   ```

3. Откройте `http://localhost:4173`.

## Деплой на Vercel

1. Загрузите проект в GitHub в репозиторий `image_gen`.
2. В Vercel создайте новый проект из этого репозитория. Если Vercel спросит настройки, выберите Framework Preset `Other`, Build Command оставьте пустым.
3. В `Settings -> Environment Variables` добавьте:

   ```bash
   POLZA_API_KEY=ваш_ключ_polza
   ```

4. Нажмите Deploy. Тестовый домен будет вида `https://image-gen.vercel.app` или похожий, потому что домены обычно не поддерживают underscore.

## API

Проект использует `POST https://polza.ai/api/v1/media` в асинхронном режиме и затем опрашивает `GET https://polza.ai/api/v1/media/{id}`.

Документация Polza:

- https://polza.ai/docs/gaidy/gpt-5-4-image-2
- https://polza.ai/docs/api-reference/media/create
