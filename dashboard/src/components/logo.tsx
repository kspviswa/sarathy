import logo from "/icons/icon-192.png";

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <img
      src={logo}
      alt="Sarathy"
      width={size}
      height={size}
      className="rounded-xl shadow-sm"
      draggable={false}
    />
  );
}