import { Card } from "@/components/ui/card";
import { 
  Shield, 
  Database, 
  Network, 
  Key, 
  HardDrive, 
  Zap,
  Globe,
  RefreshCw,
  Lock
} from "lucide-react";

const Features = () => {
  const features = [
    {
      icon: Shield,
      title: "Military-Grade Encryption",
      description: "AES-256 encryption with secure key derivation ensures your data remains completely private and secure.",
      color: "text-cyber-green"
    },
    {
      icon: Database,
      title: "RAID-Like Redundancy",
      description: "Reed-Solomon erasure coding provides fault tolerance, allowing data recovery even if multiple nodes fail.",
      color: "text-cyber-blue"
    },
    {
      icon: Network,
      title: "Peer-to-Peer Distribution",
      description: "Distributed storage across multiple peers eliminates single points of failure and increases availability.",
      color: "text-cyber-purple"
    },
    {
      icon: Key,
      title: "Zero-Knowledge Architecture",
      description: "Your encryption keys never leave your control. The server cannot access your data, even if compromised.",
      color: "text-cyber-orange"
    },
    {
      icon: HardDrive,
      title: "Elastic Storage Buckets",
      description: "Allocate storage space in flexible bucket sizes that automatically distribute across the network.",
      color: "text-cyber-green"
    },
    {
      icon: Zap,
      title: "Lightning Fast Sync",
      description: "Optimized chunking and parallel transfers ensure your files are synchronized rapidly across peers.",
      color: "text-cyber-blue"
    },
    {
      icon: Globe,
      title: "Global Network",
      description: "Connect to peers worldwide for maximum redundancy and geographical distribution of your data.",
      color: "text-cyber-purple"
    },
    {
      icon: RefreshCw,
      title: "Automatic Recovery",
      description: "Built-in monitoring and repair mechanisms automatically reconstruct lost data from available chunks.",
      color: "text-cyber-orange"
    },
    {
      icon: Lock,
      title: "Secure Key Recovery",
      description: "Multi-factor authentication and Shamir's Secret Sharing provide secure access recovery options.",
      color: "text-cyber-green"
    }
  ];

  return (
    <section className="py-24 bg-gradient-accent">
      <div className="container mx-auto px-6">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-6 bg-gradient-primary bg-clip-text text-transparent">
            Revolutionary Storage Technology
          </h2>
          <p className="text-xl text-muted-foreground max-w-3xl mx-auto">
            Experience the future of data storage with our cutting-edge distributed encryption system
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <Card 
                key={index} 
                className="p-6 bg-card/50 backdrop-blur-sm border-border/50 hover:shadow-card transition-all duration-300 hover:scale-105 group"
              >
                <div className="flex items-start space-x-4">
                  <div className={`p-3 rounded-lg bg-background/50 ${feature.color} group-hover:animate-pulse-glow`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold mb-2 group-hover:text-primary transition-colors">
                      {feature.title}
                    </h3>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default Features;