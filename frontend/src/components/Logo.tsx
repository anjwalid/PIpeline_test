import logoProject from '../../assets/Logo_project.png';

export function Logo() {
  return (
    <img
      src={logoProject}
      alt="Astoria logo"
      className="h-10 w-auto object-contain"
    />
  );
}
