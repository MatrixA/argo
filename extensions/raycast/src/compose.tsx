import { Action, ActionPanel, Form, Icon, useNavigation } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { getImage, importImage, releaseImage, type LocalImage } from "./images.js";

export function Compose({
  text,
  change,
  send,
  imageId,
  changeImage,
  imageUnavailable,
  description = "Your draft is saved on this Mac as you type. Nothing sends automatically, including after reconnecting. Send submits to the hub queue only when the Agent is online; a busy Agent receives it after the current turn.",
  title = "Compose Message",
  submitTitle = "Send Message",
}: {
  text: string;
  change: (text: string) => void;
  send: (text: string, imageId?: string) => Promise<boolean>;
  imageId?: string;
  changeImage?: (imageId?: string) => void | Promise<void>;
  imageUnavailable?: string;
  description?: string;
  title?: string;
  submitTitle?: string;
}) {
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(Boolean(imageId));
  const [selectedId, setSelectedId] = useState(imageId);
  const [image, setImage] = useState<LocalImage>();
  const [error, setError] = useState<string>();
  const lock = useRef(Boolean(imageId));
  const mounted = useRef(true);
  const { pop } = useNavigation();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    lock.current = true;
    setBusy(true);
    void getImage(selectedId)
      .then((saved) => {
        if (active) setImage(saved);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load the image. Your draft is kept.");
      })
      .finally(() => {
        if (active) {
          lock.current = false;
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId]);
  async function select(paths: string[]) {
    if (!changeImage || lock.current || !mounted.current) return;
    lock.current = true;
    setBusy(true);
    let next: LocalImage | undefined;
    try {
      next = paths[0] ? await importImage(paths[0]) : undefined;
      if (!mounted.current) {
        if (next) await releaseImage(next.id);
        return;
      }
      await changeImage(next?.id);
      if (!mounted.current) return;
      const old = selectedId;
      setSelectedId(next?.id);
      setImage(next);
      setError(undefined);
      if (old && old !== next?.id) await releaseImage(old).catch(() => {});
    } catch (cause) {
      if (next && next.id !== selectedId) await releaseImage(next.id).catch(() => {});
      if (mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Could not save this image. Your previous attachment is kept.",
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Form
      navigationTitle={title}
      isLoading={busy}
      enableDrafts={false}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={submitTitle}
            icon={Icon.ArrowUp}
            onSubmit={async () => {
              if (lock.current || !mounted.current) return;
              if (selectedId && (error || imageUnavailable)) {
                setError(error || imageUnavailable);
                return;
              }
              lock.current = true;
              setBusy(true);
              try {
                if ((await send(value, selectedId)) && mounted.current) pop();
              } finally {
                lock.current = false;
                if (mounted.current) setBusy(false);
              }
            }}
          />
          {image ? <Action.Open title="Preview Image" icon={Icon.Eye} target={image.path} /> : null}
          {selectedId ? <Action title="Remove Image" icon={Icon.Trash} onAction={() => select([])} /> : null}
        </ActionPanel>
      }
    >
      <Form.Description text={description} />
      <Form.TextArea
        id="text"
        title="Message"
        value={value}
        onChange={(next) => {
          setValue(next);
          change(next);
        }}
        error={value.length > 100_000 ? "Maximum 100,000 characters" : undefined}
        autoFocus
      />
      {changeImage ? (
        <Form.FilePicker
          id="image"
          title="Image"
          value={image ? [image.path] : []}
          canChooseDirectories={false}
          allowMultipleSelection={false}
          onChange={(paths) => {
            void select(paths);
          }}
          info="One PNG, JPEG or WebP up to 4 MiB. Preview, replace or remove it before sending."
          error={error}
        />
      ) : null}
      {imageUnavailable ? <Form.Description title="Image Availability" text={imageUnavailable} /> : null}
    </Form>
  );
}
